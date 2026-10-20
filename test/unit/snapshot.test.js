// readSnapshot() against a fake chrome: only normal windows, the editor's own URL is dropped twice over.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSnapshot } from '../../src/core/snapshot.js';
import { render } from '../../src/core/render.js';

const EDITOR = 'chrome-extension://abc/editor.html';
const tab = (id, index, url, extra = {}) => ({ id, index, title: `T${id}`, url, pinned: false, active: index === 0, groupId: -1, ...extra });

const fake = ({ windows, groups = [], tree }) => ({
  windows: { getAll: async () => windows },
  tabGroups: { query: async () => groups },
  bookmarks: { getTree: async () => tree },
});
const TREE = [{ id: '0', title: '', children: [
  { id: '1', title: 'Bookmarks Bar', children: [{ id: '5', title: 'A', url: 'https://a.test/' }] },
  { id: '2', title: 'Other Bookmarks', children: [] },
  { id: '9', title: 'Managed', unmodifiable: 'managed', children: [] },
] }];

test('lists normal windows only; popups (the editor window) are left out', async () => {
  const api = fake({
    windows: [
      { id: 1, type: 'normal', focused: false, tabs: [tab(11, 0, 'https://x.test/')] },
      { id: 2, type: 'popup', focused: true, tabs: [tab(21, 0, EDITOR)] },
    ],
    tree: TREE,
  });
  const snap = await readSnapshot(api, { editorUrl: EDITOR });
  assert.deepEqual(snap.windows.map((w) => w.id), [1]);
});

test('a tab showing the editor URL inside a normal window is dropped too (also while still loading)', async () => {
  const api = fake({
    windows: [{ id: 1, type: 'normal', focused: true, tabs: [tab(11, 0, 'https://x.test/'), tab(12, 1, EDITOR), tab(13, 2, '', { pendingUrl: EDITOR })] }],
    tree: TREE,
  });
  const snap = await readSnapshot(api, { editorUrl: EDITOR });
  assert.deepEqual(snap.windows[0].tabs.map((t) => t.id), [11]);
});

test('a window that only held the editor tab disappears; its groups are dropped with it', async () => {
  const api = fake({
    windows: [{ id: 1, type: 'normal', focused: true, tabs: [tab(12, 0, EDITOR)] }, { id: 3, type: 'normal', focused: false, tabs: [tab(31, 0, 'https://y.test/', { groupId: 7 })] }],
    groups: [{ id: 7, windowId: 3, title: 'G', color: 'red', collapsed: false }, { id: 8, windowId: 1, title: 'gone', color: 'blue', collapsed: false }],
    tree: TREE,
  });
  const snap = await readSnapshot(api, { editorUrl: EDITOR });
  assert.deepEqual(snap.windows.map((w) => w.id), [3]);
  assert.deepEqual(snap.groups.map((g) => g.id), [7]);
});

test('managed (unmodifiable) bookmark roots are skipped', async () => {
  const api = fake({ windows: [], tree: TREE });
  const snap = await readSnapshot(api, { editorUrl: EDITOR });
  assert.deepEqual(snap.bookmarks.map((b) => b.id), ['1', '2']);
});

test('focusWindowId marks a window focused only when no normal window has focus', async () => {
  const mk = (focused) => fake({ windows: [{ id: 1, type: 'normal', focused, tabs: [tab(11, 0, 'https://x.test/')] }, { id: 3, type: 'normal', focused: false, tabs: [tab(31, 0, 'https://y.test/')] }], tree: TREE });
  assert.deepEqual((await readSnapshot(mk(false), { editorUrl: EDITOR, focusWindowId: 3 })).windows.map((w) => w.focused), [false, true]);
  assert.deepEqual((await readSnapshot(mk(true), { editorUrl: EDITOR, focusWindowId: 3 })).windows.map((w) => w.focused), [true, false]);
});

test('an empty tab URL falls back to pendingUrl, then about:blank (normalisation)', async () => {
  const api = fake({
    windows: [{ id: 1, type: 'normal', focused: true, tabs: [tab(11, 0, '', { pendingUrl: 'https://p.test/' }), tab(12, 1, '')] }],
    tree: TREE,
  });
  const text = render(await readSnapshot(api, { editorUrl: EDITOR })).text;
  assert.match(text, /\/t11 T11 https:\/\/p\.test\//);
  assert.match(text, /\/t12 T12 about:blank/);
});
