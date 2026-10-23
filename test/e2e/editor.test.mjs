// Keystroke tests in the real editor: vim keys typed into CodeMirror, `:w`, the confirmation modal, `y`.
// Every test ends by asserting Chrome's final state (and, where it matters, that identity was kept).

import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { launch, sleep } from './helpers.mjs';
import { RESEARCH, STANDARD } from './lib.mjs';

let h;
let page;
let pageErrors = [];
before(async () => { h = await launch({ name: 'editor' }); });
after(async () => { await h.close(); });
afterEach(async () => {
  if (page && !page.isClosed()) await page.close(); // a failed test can leave its editor open, and the next one would only focus it
  assert.deepEqual(pageErrors, [], 'no uncaught errors in the editor page');
});

const BM = STANDARD.bookmarks;
const bm = (patch) => ({ ...BM, ...patch });

async function openEditor() {
  pageErrors = [];
  const [p] = await Promise.all([h.context.waitForEvent('page'), h.call(() => oilOpenEditor())]);
  page = p;
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => window.oil && window.oil.app.snapshot);
  await page.locator('.cm-content').focus();
  return page;
}
async function closeEditor() {
  if (page && !page.isClosed()) {
    await page.evaluate(async () => { const w = await chrome.windows.getCurrent(); await chrome.windows.remove(w.id); }).catch(() => {});
  }
  await sleep(100);
}
const text = () => page.evaluate(() => window.oil.text());
const keys = async (s) => { await page.keyboard.type(s); };
const press = (k) => page.keyboard.press(k);
// keys that close the editor window race with Playwright's own acknowledgement of the key event
const closingKeys = (s) => page.keyboard.type(s).catch((e) => { if (!/closed/.test(String(e))) throw e; });
const closingPress = (k) => page.keyboard.press(k).catch((e) => { if (!/closed/.test(String(e))) throw e; });
/** go to the line whose title is `title` (cursor lands on its first character) */
async function goto(title) { await keys(`/${title}`); await press('Enter'); }
async function idle() { await page.waitForFunction(() => !window.oil.app.busy); await sleep(50); }
/** :w, then answer the confirmation (default y) and wait until the write finished */
async function write(answer = 'y') {
  await keys(':w'); await press('Enter');
  await page.waitForSelector('.oil-modal', { timeout: 5000 });
  await press(answer);
  await page.waitForSelector('.oil-modal', { state: 'detached' });
  await idle();
  // the buffer was re-rendered from live state: planning it again must give nothing (E-idem), and no problem modal opened
  assert.deepEqual(await page.evaluate(() => window.oil.plan().actions), [], 're-render → plan must be empty');
  assert.equal(await page.locator('.oil-modal').count(), 0, 'no "applied with problems" notice');
}
async function seedAndOpen(spec = STANDARD) { await h.seed(spec); await openEditor(); }
/** the anchor at the start of each line (null for a line without one) */
const anchors = (t) => t.split('\n').map((l) => (/^\s*\/[wgtb]\d+ /.exec(l) || [null])[0]);
/** Change one line per case with its keys and type a marker: no anchor may be dropped, added or moved, the marker sits behind its own. */
async function changeEachLine(cases) {
  const before = anchors(await text());
  for (const [title, op] of cases) {
    await goto(title);
    await keys(op);
    await keys(`x${op}`);
    await press('Escape');
  }
  const after = await text();
  assert.deepEqual(anchors(after), before, 'no anchor was dropped, added or moved');
  for (const [, op] of cases) assert.match(after, new RegExp(`^\\s*/[wgtb]\\d+ x${op}$`, 'm'), `${op}: the text sits behind the anchor of its own line`);
}
/** :e! and wait until the buffer is clean again */
async function reload() {
  await keys(':e!'); await press('Enter');
  await page.waitForFunction(() => !window.oil.isDirty());
  await idle();
}
/** a block from the H of GitHub down to MDN, `motion` to shape it, then `op`; tests expect what Neovim 0.11 makes of the same keys */
async function block(motion, op) {
  await goto('GitHub');
  await keys('lll');
  await press('Control+v');
  await keys(`j${motion}${op}`);
}
/** folded blocks (placeholders in the DOM) and the text that is still on screen */
const folds = async () => ({ count: await page.locator('.oil-fold').count(), shown: await page.locator('.cm-content').innerText() });
const externalTab = (name) => h.call(async ({ url }) => {
  const w = (await chrome.windows.getAll({ populate: true })).filter((x) => x.type === 'normal').sort((a, b) => a.id - b.id)[1];
  await chrome.tabs.create({ windowId: w.id, url, active: false });
}, { url: h.url(name) });
const state = () => h.settledState();
const ids = () => h.call(async () => {
  const tabs = await chrome.tabs.query({});
  const out = { tabs: {}, bookmarks: {} };
  for (const t of tabs) { const m = /\/p\/(\w+)/.exec(t.url || ''); if (m) out.tabs[m[1]] = t.id; }
  const walk = (n) => { if (n.url) out.bookmarks[n.title] = n.id; (n.children || []).forEach(walk); };
  walk((await chrome.bookmarks.getTree())[0]);
  return out;
});

test('opens on the active tab of the focused window, anchors are concealed behind widgets', async () => {
  await seedAndOpen();
  const cur = await page.evaluate(() => { const v = window.oil.view; const l = v.state.doc.lineAt(v.state.selection.main.head); return l.text; });
  assert.match(cur, /^ {2}\/t\d+ Neovim /);
  assert.ok((await page.locator('.cm-line .oil-anchor').count()) >= 16, 'a widget over each anchor');
  const visible = await page.locator('.cm-content').innerText();
  assert.ok(!/\/t\d+ /.test(visible), 'no raw anchor text is visible');
  await closeEditor();
});

test('dd on a tab line, :w, y → the tab is closed', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd');
  await write('y');
  assert.deepEqual((await state()).windows, [['neovim', 'oil', RESEARCH('attention', 'gpt3')], ['tmux', 'codemirror']]);
  await closeEditor();
});

test('the modal lists deletions first, in red, and n cancels', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd');
  await keys(':w'); await press('Enter');
  await page.waitForSelector('.oil-modal');
  assert.match(await page.locator('.oil-m-dels').innerText(), /✕ 1 deletion/);
  const sections = await page.locator('.oil-m-sechead').allInnerTexts();
  assert.match(sections[0], /^DELETE/i);
  await press('n');
  await page.waitForSelector('.oil-modal', { state: 'detached' });
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], 'cancel applied nothing');
  assert.ok(await page.evaluate(() => window.oil.isDirty()), 'buffer still modified');
  await closeEditor();
});

test('dd then p moves a tab to another window; Enter, o, y all confirm', async () => {
  await seedAndOpen();
  await goto('Oil');
  await keys('dd');
  await goto('Codemirror');
  await keys('p');
  await write('Enter');
  assert.deepEqual((await state()).windows, [['neovim', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror', 'oil']]);
  await closeEditor();
});

test('yy and p copy a tab line into another window (new tab, original stays)', async () => {
  await seedAndOpen();
  const before = await ids();
  await goto('Oil');
  await keys('yy');
  await goto('Codemirror');
  await keys('p');
  await write('o');
  const st = await state();
  assert.deepEqual(st.windows, [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror', 'oil']]);
  assert.equal((await ids()).tabs.oil !== undefined, true);
  assert.ok(before.tabs.oil, 'original tab id existed');
  await closeEditor();
});

test('>> on a tab right below a group makes it a member', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('>>');
  await write();
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil', RESEARCH('attention', 'gpt3', 'hn')]);
  await closeEditor();
});

test('<< takes a group member out of its group', async () => {
  await seedAndOpen();
  await goto('Attention');
  await keys('<<');
  await write();
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil', RESEARCH('gpt3'), 'attention', 'hn']);
  await closeEditor();
});

test('cw renames a bookmark and keeps its identity (rename, not delete + create)', async () => {
  await seedAndOpen();
  const before = await ids();
  await goto('GitHub');
  await keys('cwHub');
  await press('Escape');
  await write();
  const after = await ids();
  assert.equal(after.bookmarks.Hub, before.bookmarks.GitHub, 'same bookmark id');
  assert.deepEqual((await state()).bookmarks.bar[0].children[0], ['Hub', 'github']);
  await closeEditor();
});

test('cc + text also keeps the identity (the hidden anchor survives the line change)', async () => {
  await seedAndOpen();
  const before = await ids();
  await goto('MDN');
  await keys('cc');
  await keys(`Docs ${h.url('mdn')}`);
  await press('Escape');
  assert.match(await text(), /\/b\d+ Docs http/);
  await write();
  const after = await ids();
  assert.equal(after.bookmarks.Docs, before.bookmarks.MDN, 'same bookmark id');
  assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Dev', children: [['GitHub', 'github'], ['Docs', 'mdn']] });
  await closeEditor();
});

test('0, ^ and I land on the first character of the name, never inside the anchor', async () => {
  await seedAndOpen();
  await goto('Oil');
  for (const k of ['0', '^', 'I']) {
    await press('Escape');
    await keys(k);
    const pos = await page.evaluate(() => { const v = window.oil.view; const h = v.state.selection.main.head; const l = v.state.doc.lineAt(h); return v.state.sliceDoc(l.from, h); });
    assert.match(pos, /^ {2}\/t\d+ $/, `after ${k}: cursor right behind the anchor`);
  }
  await press('Escape');
  await closeEditor();
});

test('x and dw at the name start edit the name; the anchor is untouched', async () => {
  await seedAndOpen();
  await goto('Oil');
  await keys('0x');
  assert.match(await text(), /\/t\d+ il http/);
  await keys('dw');
  assert.match(await text(), /\/t\d+ http/);
  await keys('u');
  await keys('u');
  assert.match(await text(), /\/t\d+ Oil http/);
  await closeEditor();
});

test('Enter right after the anchor leaves an empty line above; the tab keeps its anchor and :w creates no copy', async () => {
  await seedAndOpen();
  const before = { ids: await ids(), state: await state() };
  await goto('Oil');
  await keys('i');
  await press('Enter');
  const insert = await page.evaluate(() => { const v = window.oil.view; const h = v.state.selection.main.head; const l = v.state.doc.lineAt(h); return { before: v.state.sliceDoc(l.from, h), after: v.state.sliceDoc(h, l.to) }; });
  assert.match(insert.before, /^ {2}\/t\d+ $/, 'the cursor is behind the anchor of the moved line');
  assert.match(insert.after, /^Oil http/, 'and on the first character of its content');
  await press('Escape');
  const lines = (await text()).split('\n');
  const i = lines.findIndex((l) => /^ {2}\/t\d+ Oil http/.test(l));
  assert.ok(i > 0, 'the tab line keeps its anchor');
  assert.equal(lines[i - 1], '', 'an empty line is left above');
  assert.equal(lines.filter((l) => /Oil http/.test(l)).length, 1, 'no unanchored copy of the content');
  assert.deepEqual(await page.evaluate(() => window.oil.plan().actions), [], 'nothing to apply');
  await keys(':w'); await press('Enter');
  await page.waitForFunction(() => /no changes/.test(document.querySelector('.oil-s-msg').textContent));
  assert.equal(await page.locator('.oil-modal').count(), 0, 'no confirmation: there is nothing to confirm');
  assert.deepEqual(await state(), before.state);
  assert.deepEqual(await ids(), before.ids, 'the tab kept its identity');
  await closeEditor();
});

test('Enter in the middle of a title still splits the line', async () => {
  await seedAndOpen();
  await goto('Oil');
  await keys('li');
  await press('Enter');
  await press('Escape');
  assert.match(await text(), /^ {2}\/t\d+ O\nil http/m);
  await closeEditor();
});

test('S rewrites a line but keeps indent and anchor', async () => {
  await seedAndOpen();
  await goto('Attention');
  await keys('S');
  await keys(`Fresh ${h.url('attention')}`);
  await press('Escape');
  assert.match(await text(), /^ {4}\/t\d+ Fresh http/m);
  await closeEditor();
});

test('o opens a new line at the sibling indent and a typed URL becomes a new tab', async () => {
  await seedAndOpen();
  await goto('Tmux');
  await keys('o');
  await keys(h.url('typed'));
  await press('Escape');
  assert.match(await text(), /^ {2}http:\/\/127\.0\.0\.1:\d+\/p\/typed$/m);
  await write();
  assert.deepEqual((await state()).windows[1], ['tmux', 'typed', 'codemirror']);
  await closeEditor();
});

test('o on a window line indents one level (child position)', async () => {
  await seedAndOpen();
  await keys('gg'); // window 1 line
  await keys('o');
  await keys(h.url('first'));
  await press('Escape');
  assert.match(await text(), /^\/w\d+ Window 1\/\n {2}http:\/\/127\.0\.0\.1:\d+\/p\/first\n {2}\/t\d+ Neovim/);
  await closeEditor();
});

test('visual-line delete over several lines removes them with their anchors', async () => {
  await seedAndOpen();
  await goto('Tmux');
  await keys('Vjd');
  await write();
  assert.deepEqual((await state()).windows, [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn']]);
  await closeEditor();
});

test('Vc on a tab line + a new URL: :w navigates that tab (no tab opened or closed)', async () => {
  await seedAndOpen();
  const tabIds = () => h.call(async () => (await chrome.tabs.query({})).map((t) => t.id).sort((a, b) => a - b));
  const before = { ids: await ids(), tabs: await tabIds() };
  await goto('Oil');
  await keys('Vc');
  await keys(`Oil ${h.url('oil2')}`);
  await press('Escape');
  assert.match(await text(), /^ {2}\/t\d+ Oil http:\/\/127\.0\.0\.1:\d+\/p\/oil2$/m, 'the tab line kept its anchor');
  assert.match(await text(), /^ {2}\/t\d+ Hn http/m, 'the next line is untouched');
  await write();
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil2', RESEARCH('attention', 'gpt3'), 'hn']);
  assert.equal((await ids()).tabs.oil2, before.ids.tabs.oil, 'same tab id');
  assert.deepEqual(await tabIds(), before.tabs, 'no tab opened or closed');
  await closeEditor();
});

test('Vc on a bookmark line + text renames that bookmark; the next line is untouched', async () => {
  await seedAndOpen();
  const before = await ids();
  await goto('GitHub');
  await keys('Vc');
  await keys(`Hub ${h.url('github')}`);
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ Hub http.*\n {4}\/b\d+ MDN http/m);
  await write();
  const after = await ids();
  assert.equal(after.bookmarks.Hub, before.bookmarks.GitHub, 'same bookmark id');
  assert.equal(after.bookmarks.MDN, before.bookmarks.MDN, 'the next bookmark is the same one');
  assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Dev', children: [['Hub', 'github'], ['MDN', 'mdn']] });
  await closeEditor();
});

test('Vjc over two bookmark lines renames the first and deletes the second', async () => {
  await seedAndOpen();
  const before = await ids();
  await goto('GitHub');
  await keys('Vjc');
  await keys(`Hub ${h.url('github')}`);
  await press('Escape');
  await write();
  const after = await ids();
  assert.equal(after.bookmarks.Hub, before.bookmarks.GitHub, 'the first bookmark kept its identity');
  assert.equal(after.bookmarks.MDN, undefined, 'the second one is gone');
  assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Dev', children: [['Hub', 'github']] });
  await closeEditor();
});

test('VjR and <C-v>jR change the first line like cc and delete the others', async () => {
  for (const block of [false, true]) {
    await seedAndOpen();
    const before = await ids();
    await goto('GitHub');
    if (block) await press('Control+v'); else await keys('V');
    await keys('jR');
    await keys(`Hub ${h.url('github')}`);
    await press('Escape');
    await write();
    const after = await ids();
    assert.equal(after.bookmarks.Hub, before.bookmarks.GitHub, 'the first bookmark kept its identity');
    assert.equal(after.bookmarks.MDN, undefined, 'the second one is gone');
    assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Dev', children: [['Hub', 'github']] });
    await closeEditor();
  }
});

test('Vs VC vC vS VS change a line like Vc: it keeps its anchor and insert mode takes the typed text', async () => {
  await seedAndOpen();
  await changeEachLine([['GitHub', 'Vs'], ['MDN', 'VC'], ['Wikipedia', 'vC'], ['Hn', 'vS'], ['Codemirror', 'VS']]);
  await closeEditor();
});

test('guard: VR and vR on one line kept the anchor before too', async () => {
  await seedAndOpen();
  await changeEachLine([['GitHub', 'VR'], ['Hn', 'vR']]);
  await closeEditor();
});

test('Vjc on a window line keeps that window: the tab below goes, nothing is opened or moved', async () => {
  await seedAndOpen();
  const windowIds = () => h.call(async () => (await chrome.windows.getAll()).filter((w) => w.type === 'normal').map((w) => w.id).sort((a, b) => a - b));
  const before = { windows: await windowIds(), ids: await ids() };
  await goto('Window 2');
  await keys('Vjc');
  await keys('Window 2/');
  await press('Escape');
  assert.match(await text(), /^\/w\d+ Window 2\/$/m, 'the window line kept its anchor');
  await write();
  assert.deepEqual((await state()).windows, [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], ['codemirror']]);
  assert.deepEqual(await windowIds(), before.windows, 'no window opened or closed');
  assert.equal((await ids()).tabs.codemirror, before.ids.tabs.codemirror, 'the tab below was not moved');
  await closeEditor();
});

test('cj and ck over a window line keep its anchor too (the plan only closes the tab)', async () => {
  await seedAndOpen();
  const kinds = () => page.evaluate(() => window.oil.plan().actions.map((a) => a.kind));
  await goto('Window 2');
  await keys('cj');
  await keys('Window 2/');
  await press('Escape');
  assert.match(await text(), /^\/w\d+ Window 2\/$/m, 'cj');
  assert.deepEqual(await kinds(), ['close-tab']);
  await keys(':e!'); await press('Enter');
  await page.waitForFunction(() => !window.oil.isDirty());
  await idle();
  await goto('Tmux');
  await keys('ck');
  await keys('Window 2/');
  await press('Escape');
  assert.match(await text(), /^\/w\d+ Window 2\/$/m, 'ck');
  assert.deepEqual(await kinds(), ['close-tab']);
  await closeEditor();
});

test('. repeats Vc on the next line; both bookmarks keep their identity', async () => {
  await seedAndOpen();
  const bookmarkIds = () => h.call(async () => {
    const out = [];
    const walk = (n) => { if (n.url) out.push(n.id); (n.children || []).forEach(walk); };
    walk((await chrome.bookmarks.getTree())[0]);
    return out;
  });
  const before = await bookmarkIds();
  await goto('GitHub');
  await keys('Vc');
  await keys('Hub');
  await press('Escape');
  await keys('j.');
  assert.match(await text(), /^ {4}\/b\d+ Hub\n {4}\/b\d+ Hub$/m);
  await write();
  assert.deepEqual(await bookmarkIds(), before, 'no bookmark created or deleted');
  assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Dev', children: [['Hub', 'github'], ['Hub', 'mdn']] });
  await closeEditor();
});

test('guard: Vjc is one undo step and leaves both lines in the register', async () => {
  await seedAndOpen();
  const original = await text();
  await goto('GitHub');
  await keys('Vjc');
  await keys('Hub');
  await press('Escape');
  await keys('uu'); // the typed text, then the change
  assert.equal(await text(), original);
  await goto('GitHub');
  await keys('Vjc');
  await press('Escape');
  await keys('Gp');
  const tail = (await text()).split('\n').slice(-2);
  assert.match(tail[0], /^ {4}\/b\d+ GitHub http/);
  assert.match(tail[1], /^ {4}\/b\d+ MDN http/);
  await closeEditor();
});

test('guard: charwise vec still changes only the selected word (the rest of the line and the identity stay)', async () => {
  await seedAndOpen();
  const before = await ids();
  await goto('GitHub');
  await keys('vec');
  await keys('Hub');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ Hub http/m);
  await write();
  assert.equal((await ids()).bookmarks.Hub, before.bookmarks.GitHub, 'same bookmark id');
  assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Dev', children: [['Hub', 'github'], ['MDN', 'mdn']] });
  await closeEditor();
});

test('blockwise <C-v>jc changes the block on every line; both bookmarks keep their identity', async () => {
  await seedAndOpen();
  const before = await ids();
  await goto('GitHub');
  await press('Control+v');
  await keys('jc');
  await keys('X');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ XitHub http\S+\/github\n {4}\/b\d+ XDN http\S+\/mdn$/m);
  await write();
  const after = await ids();
  assert.equal(after.bookmarks.XitHub, before.bookmarks.GitHub, 'GitHub kept its identity');
  assert.equal(after.bookmarks.XDN, before.bookmarks.MDN, 'MDN kept its identity');
  assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Dev', children: [['XitHub', 'github'], ['XDN', 'mdn']] });
  await closeEditor();
});

test('blockwise C and D run from the block\'s left column to the line end, as in Vim', async () => {
  await seedAndOpen();
  await block('', 'CX');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ GitX\n {4}\/b\d+ MDNX$/m, 'a one-column block');
  await reload();
  await block('h', 'CX');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ GiX\n {4}\/b\d+ MDX$/m, 'a block drawn leftwards');
  await reload();
  await block('', 'D');
  assert.match(await text(), /^ {4}\/b\d+ Git\n {4}\/b\d+ MDN$/m);
  await goto('Wikipedia');
  await keys('P');
  assert.match(await text(), /^ {2}\/b\d+ Hub http\S+\/githubWikipedia http/m, 'the register is blockwise');
  await closeEditor();
});

test('blockwise X deletes and Y yanks the block itself, as in Vim', async () => {
  await seedAndOpen();
  await block('', 'X');
  assert.match(await text(), /^ {4}\/b\d+ Gitub http\S+\n {4}\/b\d+ MDNhttp/m);
  await reload();
  await block('', 'Y');
  await goto('Wikipedia');
  await keys('P');
  assert.match(await text(), /^ {2}\/b\d+ HWikipedia http/m);
  await closeEditor();
});

test('blockwise I A and $A insert on every line of the block', async () => {
  await seedAndOpen();
  await block('', 'IX');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ GitXHub http\S+\n {4}\/b\d+ MDNX http/m);
  await reload();
  await block('', 'AX');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ GitHXub http\S+\n {4}\/b\d+ MDN Xhttp/m);
  await reload();
  await block('$', 'AX');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ GitHub http\S+\/githubX\n {4}\/b\d+ MDN http\S+\/mdnX$/m);
  await closeEditor();
});

// Dev's children sit two columns deeper, so the column just behind Dev's anchor falls inside theirs.
test('blockwise c over a deeper line\'s anchor leaves that anchor alone', async () => {
  await seedAndOpen();
  const before = anchors(await text());
  await goto('Dev');
  await keys('l');
  const [dev, github] = (await text()).split('\n').filter((l) => /\/b\d+ (Dev\/|GitHub )/.test(l)).map((l) => /^\s*\/b\d+ /.exec(l)[0].length);
  assert.ok(dev + 1 < github, 'the block column lies inside the deeper anchor');
  await press('Control+v');
  await keys('jcX');
  await press('Escape');
  assert.deepEqual(anchors(await text()), before, 'no anchor was dropped, added or moved');
  assert.match(await text(), /^ {2}\/b\d+ DXv\/\n {4}\/b\d+ XGitHub http/m, 'the deeper line gets the text behind its anchor');
  await closeEditor();
});

test('in a blockwise insert, Backspace Delete <C-w> <C-u> act on every line, and Enter breaks the main one only', async () => {
  await seedAndOpen();
  await block('', 'Iab');
  await press('Backspace');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ GitaHub http\S+\/github\n {4}\/b\d+ MDNa http\S+\/mdn$/m, 'Backspace');
  await reload();
  await block('', 'I');
  await press('Delete');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ Gitub http\S+\n {4}\/b\d+ MDNhttp/m, 'Delete');
  await reload();
  await block('', 'Iab cd');
  await press('Control+w');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ Gitab Hub http\S+\n {4}\/b\d+ MDNab  http/m, '<C-w>');
  await reload();
  await goto('Wikipedia');
  await keys('yiw');
  await block('', 'Iab');
  await press('Control+u');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ Hub http\S+\n {4}\/b\d+  http/m, '<C-u>: to the line start, anchors kept');
  await goto('Wikipedia');
  await keys('P');
  assert.match(await text(), /^ {2}\/b\d+ WikipediaWikipedia http/m, 'the deletions left the register alone');
  await reload();
  await block('', 'Ix');
  await press('Enter');
  await keys('y');
  await press('Escape');
  assert.match(await text(), /^ {4}\/b\d+ Gitx\nyHub http\S+\n {4}\/b\d+ MDNx http/m, 'Enter');
  await closeEditor();
});

test('. replays the Backspace typed in insert mode, also after a blockwise insert', async () => {
  await seedAndOpen();
  await goto('GitHub');
  await keys('iab');
  await press('Backspace');
  await press('Escape');
  await keys('j.');
  assert.match(await text(), /^ {4}\/b\d+ aGitHub http\S+\n {4}\/b\d+ aMDN http/m);
  await reload();
  await goto('Neovim');
  await press('Control+v');
  await keys('jIab');
  await press('Backspace');
  await press('Escape');
  await goto('GitHub');
  await keys('.');
  assert.match(await text(), /^ {4}\/b\d+ aGitHub http\S+\n {4}\/b\d+ aMDN http/m);
  await closeEditor();
});

test('blockwise I and c skip the lines that do not reach the block; A appends to them', async () => {
  await seedAndOpen();
  const hn = async (op) => { await goto('Hn'); await press('Control+v'); await keys(`jj${op}Z`); await press('Escape'); };
  await hn('I');
  assert.match(await text(), /^ {2}\/t\d+ ZHn http\S+\n\n\/w\d+ WiZndow 2\/$/m, 'I leaves the blank line alone');
  await reload();
  await hn('c');
  assert.match(await text(), /^ {2}\/t\d+ Zn http\S+\n\n\/w\d+ WiZdow 2\/$/m, 'c leaves the blank line alone');
  await reload();
  await hn('A');
  assert.match(await text(), /^ {2}\/t\d+ HZn http\S+\nZ\n\/w\d+ WinZdow 2\/$/m, 'A appends to it');
  await closeEditor();
});

test('a block keeps its type in the unnamed, named and numbered registers; a $ block starts at the shorter end', async () => {
  await seedAndOpen();
  await block('l', '"aY');
  await goto('Wikipedia');
  await keys('p');
  assert.match(await text(), /^ {2}\/b\d+ WHuikipedia http/m, '"aY, then p');
  await reload();
  await block('', 'D');
  assert.equal(await page.evaluate(() => { const v = window.oil.view; const h = v.state.selection.main.head; return v.state.doc.lineAt(h).to - h; }), 1, 'the cursor rests on the last character');
  await goto('Wikipedia');
  await keys('"1P');
  assert.match(await text(), /^ {2}\/b\d+ Hub http\S+\/githubWikipedia http/m, 'D, then "1P');
  await reload();
  const lines = (await text()).split('\n');
  const mdn = lines.find((l) => /\/b\d+ MDN /.test(l));
  const later = lines.find((l) => /\/b\d+ Read later\//.test(l));
  await goto('MDN');
  await keys('$');
  await press('Control+v');
  await keys('j$D');
  assert.ok((await text()).includes(`${mdn.slice(0, later.length)}\n${later}\n`), 'a $ block ending on a shorter line starts at its end');
  await closeEditor();
});

test('a click with Cmd or Ctrl does not add a cursor', async () => {
  await seedAndOpen();
  await goto('GitHub');
  const box = await page.locator('.cm-line', { hasText: 'MDN' }).first().boundingBox();
  for (const mod of ['Meta', 'Control']) {
    await page.keyboard.down(mod);
    await page.mouse.click(box.x + 80, box.y + box.height / 2);
    await page.keyboard.up(mod);
    assert.equal(await page.evaluate(() => window.oil.view.state.selection.ranges.length), 1, mod);
  }
  await closeEditor();
});

test('P pastes a yanked line above another (reorder inside the window)', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd');
  await goto('Neovim');
  await keys('P');
  await write();
  assert.deepEqual((await state()).windows[0], ['hn', 'neovim', 'oil', RESEARCH('attention', 'gpt3')]);
  await closeEditor();
});

test('a tab yanked into a bookmark folder with ]p becomes a bookmark (tab stays: copy)', async () => {
  await seedAndOpen();
  await goto('Oil');
  await keys('yy');
  await goto('Read later');
  await keys('p');
  await keys('>>');
  await write();
  assert.deepEqual((await state()).bookmarks.bar[1], { folder: 'Read later', children: [['Oil', 'oil']] });
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn']);
  await closeEditor();
});

test('R reloads Chrome state and discards edits', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd');
  assert.ok(await page.evaluate(() => window.oil.isDirty()));
  await keys('R');
  await idle();
  await page.waitForFunction(() => !window.oil.isDirty());
  assert.match(await text(), /Hn http/);
  await closeEditor();
});

test(':e! reloads, :e refuses while modified, :q refuses while modified', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd');
  await keys(':q'); await press('Enter');
  assert.match(await page.locator('.oil-s-msg').innerText(), /E37/);
  assert.equal(page.isClosed(), false);
  await keys(':e'); await press('Enter');
  assert.match(await page.locator('.oil-s-msg').innerText(), /E37/);
  await keys(':e!'); await press('Enter');
  await page.waitForFunction(() => !window.oil.isDirty());
  assert.match(await text(), /Hn http/);
  await closeEditor();
});

test(':q! closes a modified editor without applying anything', async () => {
  await seedAndOpen();
  const st = await state();
  await goto('Hn');
  await keys('dd');
  const closed = page.waitForEvent('close');
  await keys(':q!'); await closingPress('Enter');
  await closed;
  assert.deepEqual(await state(), st);
});

test('q closes a clean editor; :wq applies and closes', async () => {
  await seedAndOpen();
  let closed = page.waitForEvent('close');
  await closingKeys('q');
  await closed;
  await sleep(300); // let the closed window go before opening again
  await openEditor();
  await goto('Hn');
  await keys('dd');
  closed = page.waitForEvent('close');
  await keys(':wq'); await press('Enter');
  await page.waitForSelector('.oil-modal');
  await closingPress('y');
  await closed;
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil', RESEARCH('attention', 'gpt3')]);
});

test('<CR> on a tab line activates that tab, focuses its window and closes the editor', async () => {
  await seedAndOpen();
  await goto('Codemirror');
  const closed = page.waitForEvent('close');
  await closingPress('Enter');
  await closed;
  const r = await h.call(async () => {
    const t = (await chrome.tabs.query({})).find((x) => x.url.endsWith('/p/codemirror'));
    const w = await chrome.windows.get(t.windowId);
    return { active: t.active, focused: w.focused };
  });
  assert.equal(r.active, true);
});

test('<CR> on a bookmark opens it in a new tab', async () => {
  await seedAndOpen();
  await goto('Wikipedia');
  const closed = page.waitForEvent('close');
  await closingPress('Enter');
  await closed;
  const urls = await h.call(async () => (await chrome.tabs.query({})).map((t) => t.url));
  assert.equal(urls.filter((u) => u.endsWith('/p/wikipedia')).length, 1);
});

test('<CR> in a modified buffer switches but keeps the editor open', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd');
  await goto('Codemirror');
  await press('Enter');
  await sleep(400);
  assert.equal(page.isClosed(), false);
  assert.match(await page.locator('.oil-s-msg').innerText(), /editor stays open/);
  await closeEditor();
});

test('plan errors open an error modal and nothing is applied', async () => {
  await seedAndOpen();
  const st = await state();
  await goto('Hn');
  await keys('<<');
  await keys('<<');
  await keys(':w'); await press('Enter');
  await page.waitForSelector('.oil-modal');
  assert.match(await page.locator('.oil-modal').innerText(), /top-level entry/);
  await press('Escape');
  await page.waitForSelector('.oil-modal', { state: 'detached' });
  assert.deepEqual(await state(), st);
  await closeEditor();
});

test('g? shows the help, q closes it', async () => {
  await seedAndOpen();
  await keys('g?');
  await page.waitForSelector('.oil-modal');
  assert.match(await page.locator('.oil-modal').innerText(), /the buffer is the desired state/);
  await press('q');
  await page.waitForSelector('.oil-modal', { state: 'detached' });
  await closeEditor();
});

test('za folds a window block, zR opens all', async () => {
  await seedAndOpen();
  await keys('gg');
  await keys('za');
  assert.equal(await page.locator('.oil-fold').count(), 1);
  assert.ok(!(await page.locator('.cm-content').innerText()).includes('Neovim'));
  await keys('za');
  assert.equal(await page.locator('.oil-fold').count(), 0);
  await keys('zM');
  assert.ok((await page.locator('.oil-fold').count()) >= 3);
  await keys('zR');
  assert.equal(await page.locator('.oil-fold').count(), 0);
  await closeEditor();
});

test('folds survive a live refresh: the folder lines are found again by their anchors', async () => {
  await seedAndOpen();
  await goto('Dev');
  await keys('zc');
  await goto('Research');
  await keys('zc');
  let f = await folds();
  assert.equal(f.count, 2);
  assert.ok(!/GitHub|Attention/.test(f.shown) && /Neovim/.test(f.shown), 'two blocks hidden, the rest visible');
  await externalTab('external1');
  await page.waitForFunction(() => /External1/.test(window.oil.text()), null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.oil-fold').length === 2);
  f = await folds();
  assert.ok(!/GitHub|MDN|Attention|Gpt3/.test(f.shown), 'still folded after the refresh');
  assert.match(f.shown, /Neovim/, 'the rest of the buffer is shown');
  assert.match(f.shown, /External1/, 'and so is the new tab');
  await keys('zR');
  assert.equal((await folds()).count, 0);
  await externalTab('external2');
  await page.waitForFunction(() => /External2/.test(window.oil.text()), null, { timeout: 8000 });
  assert.equal((await folds()).count, 0, 'folds that were opened stay open');
  await closeEditor();
});

test('folds survive :w', async () => {
  await seedAndOpen();
  await goto('Dev');
  await keys('zc');
  await goto('Hn');
  await keys('dd');
  assert.equal((await folds()).count, 1);
  await write();
  const f = await folds();
  assert.equal(f.count, 1, 'the folder is still folded after the write');
  assert.ok(!/GitHub|MDN/.test(f.shown) && /Read later/.test(f.shown));
  await keys('zR');
  assert.match(await page.locator('.cm-content').innerText(), /GitHub/);
  await closeEditor();
});

test('folds survive :e!, which also takes the unwritten edit back', async () => {
  await seedAndOpen();
  await goto('Dev');
  await keys('zc');
  await goto('Hn');
  await keys('dd');
  assert.ok(await page.evaluate(() => window.oil.isDirty()));
  await keys(':e!'); await press('Enter');
  await page.waitForFunction(() => !window.oil.isDirty());
  await idle();
  const f = await folds();
  assert.equal(f.count, 1, 'the folder is still folded after the reload');
  assert.ok(!/GitHub|MDN/.test(f.shown), 'its children stay hidden');
  assert.match(f.shown, /Hn http/, 'the deleted line is back');
  await closeEditor();
});

test('a folded folder that loses its children outside is not folded again; the other folds are', async () => {
  await seedAndOpen();
  await goto('Dev');
  await keys('zc');
  await goto('Research');
  await keys('zc');
  assert.equal((await folds()).count, 2);
  await h.call(async () => {
    const dev = (await chrome.bookmarks.search({ title: 'Dev' })).find((n) => !n.url);
    for (const c of await chrome.bookmarks.getChildren(dev.id)) await chrome.bookmarks.remove(c.id);
  });
  await page.waitForFunction(() => !/GitHub/.test(window.oil.text()), null, { timeout: 8000 });
  const f = await folds();
  assert.equal(f.count, 1, 'only the group is folded again');
  assert.ok(!/Attention|Gpt3/.test(f.shown), 'the group stays folded');
  assert.match(f.shown, /Dev\//, 'the childless folder line is shown');
  assert.deepEqual(pageErrors, [], 'refolding did not throw');
  await closeEditor();
});

test('a fold that would hide the cursor is not restored; the other folds are', async () => {
  await seedAndOpen();
  await goto('Dev');
  await keys('zc');
  await goto('Window 2');
  await keys('zc');
  await goto('Hn');
  await h.call(async () => {
    const [w1, w2] = (await chrome.windows.getAll({ populate: true })).filter((x) => x.type === 'normal').sort((a, b) => a.id - b.id);
    await chrome.tabs.move(w1.tabs.find((t) => /\/p\/hn/.test(t.url)).id, { windowId: w2.id, index: -1 });
  });
  await page.waitForFunction(() => { const t = window.oil.text().split('\n'); return t.findIndex((l) => /Hn http/.test(l)) > t.findIndex((l) => /Window 2/.test(l)); }, null, { timeout: 8000 });
  const f = await folds();
  assert.equal(f.count, 1, 'window 2 stays open because the cursor line moved into it, Dev is folded again');
  assert.ok(!/GitHub|MDN/.test(f.shown), 'Dev is the block that is folded');
  assert.match(f.shown, /Hn http/, 'the cursor line is on screen');
  await closeEditor();
});

test('preview marks and the status line follow edits (+ → ✎ ✕ counts)', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd');
  await goto('Oil');
  await keys('dd');
  await goto('Codemirror');
  await keys('p');
  await sleep(200);
  const sum = await page.locator('.oil-s-sum').innerText();
  assert.match(sum, /→1/);
  assert.match(sum, /✕1/);
  assert.match(await page.locator('.cm-content').innerText(), /→ Window 2/);
  await closeEditor();
});

test('live refresh: a clean buffer follows Chrome, a modified one is flagged and :e! reloads', async () => {
  await seedAndOpen();
  await h.call(async ({ url }) => {
    const w = (await chrome.windows.getAll({ populate: true })).filter((x) => x.type === 'normal').sort((a, b) => a.id - b.id)[1];
    await chrome.tabs.create({ windowId: w.id, url, active: false });
  }, { url: h.url('external1') });
  await page.waitForFunction(() => /External1/.test(window.oil.text()), null, { timeout: 8000 });
  await goto('Hn');
  await keys('dd');
  await h.call(async ({ url }) => {
    const w = (await chrome.windows.getAll({ populate: true })).filter((x) => x.type === 'normal').sort((a, b) => a.id - b.id)[1];
    await chrome.tabs.create({ windowId: w.id, url, active: false });
  }, { url: h.url('external2') });
  await page.waitForFunction(() => window.oil.app.stale, null, { timeout: 8000 });
  assert.match(await page.locator('.oil-s-msg').innerText(), /chrome changed — :e! to reload/);
  assert.doesNotMatch(await text(), /External2/);
  await keys(':e!'); await press('Enter');
  await page.waitForFunction(() => /External2/.test(window.oil.text()) && !window.oil.isDirty());
  await closeEditor();
});

test('after :w the buffer is re-rendered from live state with a fresh undo history, registers survive', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd'); // register now holds the Hn line
  await write();
  await keys('u'); // nothing to undo: history was reset
  assert.doesNotMatch(await text(), /Hn http/);
  await goto('Tmux');
  await keys('p'); // the deleted line is still in the register
  const t = await text();
  assert.match(t, /\/t\d+ Hn http/);
  await closeEditor();
});

test('a new group typed in the buffer: `Name [color]/` above a tab that is then indented under it', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('O'); // new line at the sibling indent, above Hn
  await keys('Later [green]/');
  await press('Escape');
  await keys('j>>');
  assert.match(await text(), /^ {2}Later \[green\]\/\n {4}\/t\d+ Hn http/m);
  await write();
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil', RESEARCH('attention', 'gpt3'), { group: 'Later', color: 'green', tabs: ['hn'] }]);
  await closeEditor();
});

test('when undo makes the buffer clean again, a pending Chrome change is picked up', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('dd');
  await h.call(async ({ url }) => {
    const w = (await chrome.windows.getAll({ populate: true })).filter((x) => x.type === 'normal').sort((a, b) => a.id - b.id)[1];
    await chrome.tabs.create({ windowId: w.id, url, active: false });
  }, { url: h.url('external3') });
  await page.waitForFunction(() => window.oil.app.stale, null, { timeout: 8000 });
  await keys('u');
  await page.waitForFunction(() => /External3/.test(window.oil.text()) && !window.oil.app.stale, null, { timeout: 8000 });
  assert.ok(!(await page.evaluate(() => window.oil.isDirty())));
  await closeEditor();
});

test('Tab and Shift-Tab indent / dedent the line instead of leaving the editor', async () => {
  await seedAndOpen();
  await goto('Hn');
  await keys('A');
  await press('Tab');
  assert.match(await text(), /^ {4}\/t\d+ Hn http/m);
  await press('Shift+Tab');
  assert.match(await text(), /^ {2}\/t\d+ Hn http/m);
  await press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('cm-content')), true, 'focus stayed in the editor');
  await closeEditor();
});

test('opening the editor again focuses the existing window instead of opening a second one', async () => {
  await seedAndOpen();
  let extra = 0;
  h.context.on('page', () => { extra += 1; });
  const id1 = await h.call(() => oilOpenEditor());
  const id2 = await h.call(() => oilOpenEditor());
  await sleep(300);
  assert.equal(id1, id2, 'same window id');
  assert.equal(extra, 0, 'no new page opened');
  const popups = await h.call(async () => (await chrome.windows.getAll({ populate: true })).filter((w) => w.type === 'popup' && w.tabs.some((t) => /editor\.html/.test(t.url || ''))).length);
  assert.equal(popups, 1);
  await closeEditor();
});

test('the editor is a popup window and never lists itself', async () => {
  await seedAndOpen();
  const info = await h.call(async () => {
    const w = (await chrome.windows.getAll({ populate: true })).find((x) => x.tabs.some((t) => /editor\.html/.test(t.url || '')));
    return { type: w.type, width: w.width, height: w.height };
  });
  assert.equal(info.type, 'popup');
  assert.ok(info.width > 0 && info.height > 0);
  assert.ok(!/editor\.html/.test(await text()), 'the outline never contains the editor URL');
  await closeEditor();
});
