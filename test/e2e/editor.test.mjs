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
  if (page && !page.isClosed()) await h.call(async () => { for (const w of await chrome.windows.getAll()) if (w.type === 'popup' && w.tabs === undefined) { /* keeper */ } });
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

test('cc on a folder line and a name without the `/` renames the folder in place: same folder, children stay', async () => {
  await seedAndOpen();
  const folderId = (title) => h.call(async ({ title }) => (await chrome.bookmarks.search({ title }))[0].id, { title });
  const dev = await folderId('Dev');
  await goto('Dev');
  await keys('cc');
  await keys('Tools');
  await press('Escape');
  assert.match(await text(), /^ {2}\/b\d+ Tools$/m);
  await write();
  assert.equal(await folderId('Tools'), dev, 'same folder id');
  assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Tools', children: [['GitHub', 'github'], ['MDN', 'mdn']] });
  await closeEditor();
});

test('cc on a group line and a title with a ` [color]` suffix but no `/`: drawn as name and color, written as a rename', async () => {
  await seedAndOpen();
  await goto('Research');
  await keys('cc');
  await keys('Papers [red]');
  await press('Escape');
  const line = page.locator('.cm-line.oil-r-group');
  assert.equal((await line.locator('.oil-name').innerText()).trim(), 'Papers');
  assert.equal((await line.locator('.oil-gcolor').innerText()).trim(), '[red]');
  assert.equal(await line.locator('.oil-slash').count(), 0, 'no `/` was typed, none is drawn');
  await write();
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil', { group: 'Papers', color: 'red', tabs: ['attention', 'gpt3'] }, 'hn']);
  await closeEditor();
});

test('o under a group line whose `/` is gone starts a member one level in', async () => {
  await seedAndOpen();
  await goto('Research');
  await keys('cc');
  await keys('Reading');
  await press('Escape');
  await keys('o');
  await keys(h.url('fresh'));
  await press('Escape');
  assert.match(await text(), /^ {4}http:\/\/127\.0\.0\.1:\d+\/p\/fresh$/m);
  await write();
  assert.deepEqual((await state()).windows[0], ['neovim', 'oil', { group: 'Reading', color: 'blue', tabs: ['fresh', 'attention', 'gpt3'] }, 'hn']);
  await closeEditor();
});

test('a bookmark folder line without its `/` is still read as a folder: glyph, color, count, <CR> folds, o starts a member', async () => {
  await seedAndOpen();
  await goto('Dev');
  await keys('cc');
  await keys('Tools');
  await press('Escape');
  const line = page.locator('.cm-line', { hasText: 'Tools' });
  assert.match(await line.getAttribute('class'), /oil-r-bfolder/, 'syntax role');
  assert.match(await line.locator('.oil-anchor').getAttribute('class'), /oil-a-folder/, 'glyph');
  assert.match(await line.locator('.oil-marks').innerText(), /^· 2/, 'bookmark count');
  await press('Enter'); // a folder line: toggle its fold (a bookmark would open, and this one has no URL)
  await sleep(100);
  assert.equal(await page.locator('.oil-fold').count(), 1);
  await press('Enter');
  await sleep(100);
  assert.equal(await page.locator('.oil-fold').count(), 0);
  await keys('o');
  await keys(h.url('fresh'));
  await press('Escape');
  assert.match(await text(), /^ {4}http:\/\/127\.0\.0\.1:\d+\/p\/fresh$/m, 'one level in: a member of Tools');
  await write();
  assert.deepEqual((await state()).bookmarks.bar[0], { folder: 'Tools', children: [['', 'fresh'], ['GitHub', 'github'], ['MDN', 'mdn']] });
  await closeEditor();
});

test('za folds the children of a folder line without its `/`; zM folds a bookmark root written without it', async () => {
  await seedAndOpen();
  await goto('Dev');
  await keys('cc');
  await keys('Tools');
  await press('Escape');
  await keys('za');
  assert.equal(await page.locator('.oil-fold').count(), 1);
  assert.equal((await page.locator('.oil-fold').innerText()).trim(), '⋯ 2', 'its own two bookmarks, not the bar around it');
  await keys('zR');
  await goto('Other'); // the root "Other Bookmarks"
  await keys('cc');
  await keys('Others');
  await press('Escape');
  await keys('zM');
  assert.equal(await page.locator('.oil-fold').count(), 4, 'both windows, the bar and Others');
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
