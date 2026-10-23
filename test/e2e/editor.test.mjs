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
  assert.deepEqual(pageErrors, [], 'no uncaught or logged errors in the editor page');
});

const BM = STANDARD.bookmarks;
const bm = (patch) => ({ ...BM, ...patch });

async function openEditor() {
  pageErrors = [];
  const [p] = await Promise.all([h.context.waitForEvent('page'), h.call(() => oilOpenEditor())]);
  page = p;
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); }); // CodeMirror logs what a key handler throws
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

test('gg G / and the jumps back work after :e! made the buffer shorter than a recorded jump', async () => {
  await seedAndOpen();
  const line = () => page.evaluate(() => { const v = window.oil.view; return v.state.doc.lineAt(v.state.selection.main.head).text; });
  const shrink = async () => {
    await keys('yy9pG'); // a jump to the end of a longer buffer
    await keys(':e!'); await press('Enter');
    await page.waitForFunction(() => !window.oil.isDirty());
    await idle();
  };
  await shrink();
  await keys('kkk');
  let start = await line();
  await keys('gg');
  assert.match(await line(), /^\/w\d+ /, 'gg goes to the first line');
  await keys("''");
  assert.equal(await line(), start, "'' goes back to where gg started");
  await keys('G');
  assert.match(await line(), /Wikipedia http/, 'G goes to the last line');
  await press('Control+o');
  assert.equal(await line(), start, '<C-o> goes back to where G started');
  await shrink();
  const reloaded = await line();
  await press('Control+o');
  assert.equal(await line(), reloaded, '<C-o> right after the reload has nothing older to go back to');
  await keys('kkk');
  start = await line();
  await keys('gg');
  await keys("''");
  assert.equal(await line(), start, "… and the next jump still records where it started");
  await goto('GitHub');
  assert.match(await line(), /GitHub http/, '/ finds the line');
  assert.equal(await page.evaluate(() => window.oil.isDirty()), false, 'no key landed in the buffer');
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
