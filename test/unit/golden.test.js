// Golden cases G1–G28 from DESIGN.md §9. The base snapshot S is the §2 render example.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXAMPLE, S, baseSnapshot, block, del, delBlock, find, insertAfter, kinds, lineOf, linesOf, moveLine, ofKind,
  renderS, reindent, replaceLine, run,
} from './fixtures.js';

const clean = (p) => {
  assert.deepEqual(p.errors, [], 'no errors');
  assert.deepEqual(p.warnings, [], 'no warnings');
};
const winItems = (p, key) => p.desired.windows.find((w) => w.key === key).items.map((i) => (i.type === 'tab' ? i.key : `${i.key}:${i.members.join(',')}`));
const lineNo = (text, key) => find(text, key);

test('G1 no edit → no actions, no errors', () => {
  assert.equal(renderS(), EXAMPLE);
  const p = run(EXAMPLE);
  assert.deepEqual(p.actions, []);
  clean(p);
});

test('G2 delete t15 line → close-tab t15', () => {
  const p = run(del(EXAMPLE, 't15'));
  assert.deepEqual(kinds(p), ['close-tab']);
  assert.equal(p.actions[0].key, 't15');
  clean(p);
});

test('G3 move t12 behind t22 → move-tab t12 → w2, w2 order [t21 t22 t12]', () => {
  const p = run(moveLine(EXAMPLE, 't12', 't22', 2));
  assert.deepEqual(kinds(p), ['move-tab']);
  const m = p.actions[0];
  assert.equal(m.key, 't12');
  assert.equal(m.window, 'w2');
  assert.equal(m.group, null);
  assert.deepEqual(winItems(p, 'w2'), ['t21', 't22', 't12']);
  assert.deepEqual(winItems(p, 'w1'), ['t11', 'g5:t13,t14', 't15']);
  clean(p);
});

test('G4 swap t21 and t22 → reorder w2 only, no move-tab', () => {
  const p = run(moveLine(EXAMPLE, 't22', 'w2', 2));
  assert.deepEqual(kinds(p), ['reorder']);
  assert.equal(p.actions[0].parent, 'w2');
  assert.deepEqual(winItems(p, 'w2'), ['t22', 't21']);
  clean(p);
});

test('G5 copy t12 line into w2 → new-tab(oil.nvim, w2), t12 untouched', () => {
  const p = run(insertAfter(EXAMPLE, 't22', [lineOf(EXAMPLE, 't12')]));
  assert.deepEqual(kinds(p), ['new-tab']);
  const n = p.actions[0];
  assert.equal(n.url, 'https://github.com/stevearc/oil.nvim');
  assert.equal(n.window, 'w2');
  assert.equal(n.copy, true);
  assert.deepEqual(winItems(p, 'w1'), ['t11', 't12', 'g5:t13,t14', 't15']);
  clean(p);
});

test('G6 w2: https://example.com/ , example.com , hello world → 2 new-tab, 1 error', () => {
  const text = insertAfter(EXAMPLE, 't22', ['  https://example.com/', '  example.com', '  hello world']);
  const p = run(text);
  assert.deepEqual(kinds(p), ['new-tab', 'new-tab']);
  assert.deepEqual(p.actions.map((a) => a.url), ['https://example.com/', 'https://example.com']);
  assert.equal(p.errors.length, 1);
  assert.equal(p.errors[0].line, lineNo(text, 't22') + 3);
  assert.match(p.errors[0].message, /cannot read a URL/);
});

test('G7 top-level `new/` with t12 + https://a.test/ → new-window, move-tab t12, new-tab a.test', () => {
  const text = `${del(EXAMPLE, 't12')}\n\nnew/\n  ${lineOf(EXAMPLE, 't12').trim()}\n  https://a.test/`;
  const p = run(text);
  assert.deepEqual([...kinds(p)].sort(), ['move-tab', 'new-tab', 'new-window']);
  const nw = ofKind(p, 'new-window')[0];
  assert.equal(nw.first, 't12');
  const mv = ofKind(p, 'move-tab')[0];
  assert.equal(mv.key, 't12');
  assert.equal(mv.window, nw.key);
  const nt = ofKind(p, 'new-tab')[0];
  assert.equal(nt.url, 'https://a.test/');
  assert.equal(nt.window, nw.key);
  assert.deepEqual(winItems(p, nw.key), ['t12', nt.key]);
  clean(p);
});

test('G8 indent t13 to 2 → move-tab t13 → w1 (ungroup), w1 order [t11 t12 (g5: t14) t13 t15]', () => {
  const p = run(replaceLine(EXAMPLE, 't13', '  /t13 Attention https://arxiv.org/abs/1706.03762'));
  assert.deepEqual(kinds(p), ['move-tab']);
  const m = p.actions[0];
  assert.equal(m.key, 't13');
  assert.equal(m.window, 'w1');
  assert.equal(m.group, null);
  assert.equal(m.fromGroup, 'g5');
  assert.deepEqual(winItems(p, 'w1'), ['t11', 't12', 'g5:t14', 't13', 't15']);
  clean(p);
});

test('G9 t15 behind t14 at indent 4 → move-tab t15 → [Research]', () => {
  const p = run(moveLine(EXAMPLE, 't15', 't14', 4));
  assert.deepEqual(kinds(p), ['move-tab']);
  const m = p.actions[0];
  assert.equal(m.key, 't15');
  assert.equal(m.group, 'g5');
  assert.equal(m.window, 'w1');
  assert.match(m.label, /Research/);
  assert.deepEqual(winItems(p, 'w1'), ['t11', 't12', 'g5:t13,t14,t15']);
  clean(p);
});

test('G10 `Later [green]/` in w1 holding t15 → new-group Later green {t15}', () => {
  const text = insertAfter(del(EXAMPLE, 't15'), 'g5', ['  Later [green]/', `    ${lineOf(EXAMPLE, 't15').trim()}`], { block: true });
  const p = run(text);
  assert.deepEqual(kinds(p), ['new-group']);
  const g = p.actions[0];
  assert.equal(g.title, 'Later');
  assert.equal(g.color, 'green');
  assert.deepEqual(g.members, ['t15']);
  assert.equal(g.window, 'w1');
  assert.deepEqual(winItems(p, 'w1'), ['t11', 't12', 'g5:t13,t14', `${g.key}:t15`]);
  clean(p);
});

test('G11 g5 → `Papers [red]/` → edit-group title+color', () => {
  const p = run(replaceLine(EXAMPLE, 'g5', '  /g5 Papers [red]/'));
  assert.deepEqual(kinds(p), ['edit-group']);
  assert.deepEqual(p.actions[0].changes, { title: 'Papers', color: 'red' });
  clean(p);
});

test('G12 delete only the g5 line → t13/t14 ungroup (move-tab), remove-group g5', () => {
  const p = run(del(EXAMPLE, 'g5'));
  assert.deepEqual(kinds(p), ['move-tab', 'move-tab', 'remove-group']);
  assert.deepEqual(ofKind(p, 'move-tab').map((a) => [a.key, a.group, a.fromGroup]), [['t13', null, 'g5'], ['t14', null, 'g5']]);
  assert.equal(ofKind(p, 'remove-group')[0].key, 'g5');
  assert.deepEqual(winItems(p, 'w1'), ['t11', 't12', 't13', 't14', 't15']);
  clean(p);
});

test('G13 edit t12 URL → navigate-tab t12', () => {
  const p = run(replaceLine(EXAMPLE, 't12', '  /t12 oil.nvim https://github.com/stevearc/oil.nvim/pulls'));
  assert.deepEqual(kinds(p), ['navigate-tab']);
  assert.equal(p.actions[0].key, 't12');
  assert.equal(p.actions[0].from, 'https://github.com/stevearc/oil.nvim');
  assert.equal(p.actions[0].to, 'https://github.com/stevearc/oil.nvim/pulls');
  clean(p);
});

test('G14 edit t12 title → no action, warning `title is read-only`', () => {
  const text = replaceLine(EXAMPLE, 't12', '  /t12 renamed https://github.com/stevearc/oil.nvim');
  const p = run(text);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, [{ line: lineNo(text, 't12'), message: 'title is read-only' }]);
});

test('G15a delete b12 → delete-bookmark b12', () => {
  const p = run(del(EXAMPLE, 'b12'));
  assert.deepEqual(kinds(p), ['delete-bookmark']);
  assert.equal(p.actions[0].key, 'b12');
  clean(p);
});

test('G15b delete the b10 block → one delete-folder b10 (2)', () => {
  const p = run(delBlock(EXAMPLE, 'b10'));
  assert.deepEqual(kinds(p), ['delete-folder']);
  assert.equal(p.actions[0].key, 'b10');
  assert.equal(p.actions[0].count, 2);
  clean(p);
});

test('G16 delete only the b10 line → move b11/b12 to the bar, delete-folder b10 (0)', () => {
  const p = run(del(EXAMPLE, 'b10'));
  assert.deepEqual(kinds(p), ['move-bookmark', 'move-bookmark', 'delete-folder']);
  assert.deepEqual(ofKind(p, 'move-bookmark').map((a) => [a.key, a.parent]), [['b11', 'b1'], ['b12', 'b1']]);
  assert.equal(ofKind(p, 'delete-folder')[0].count, 0);
  const bar = p.desired.folders.find((f) => f.key === 'b1');
  assert.deepEqual(bar.children, ['b11', 'b12', 'b13']);
  clean(p);
});

test('G17 edit b11 title → edit-bookmark', () => {
  const p = run(replaceLine(EXAMPLE, 'b11', '    /b11 GitHub! https://github.com/'));
  assert.deepEqual(kinds(p), ['edit-bookmark']);
  assert.deepEqual(p.actions[0].changes, { title: 'GitHub!' });
  clean(p);
});

test('G18 move b20 under Read later → move-bookmark b20', () => {
  const p = run(moveLine(EXAMPLE, 'b20', 'b13', 4));
  assert.deepEqual(kinds(p), ['move-bookmark']);
  assert.equal(p.actions[0].key, 'b20');
  assert.equal(p.actions[0].parent, 'b13');
  clean(p);
});

test('G19 move t15 under Read later → new-bookmark(from t15) + close-tab t15, creation first', () => {
  const p = run(moveLine(EXAMPLE, 't15', 'b13', 4));
  assert.deepEqual(kinds(p), ['new-bookmark', 'close-tab']);
  const nb = p.actions[0];
  assert.deepEqual(nb.source, { type: 'tab', key: 't15' });
  assert.equal(nb.title, 'Hacker News');
  assert.equal(nb.url, 'https://news.ycombinator.com/');
  assert.equal(nb.parent, 'b13');
  assert.equal(p.actions[1].key, 't15');
  clean(p);
});

test('G20 copy t12 under Read later → new-bookmark(from t12) only', () => {
  const p = run(insertAfter(EXAMPLE, 'b13', [`    ${lineOf(EXAMPLE, 't12').trim()}`]));
  assert.deepEqual(kinds(p), ['new-bookmark']);
  assert.deepEqual(p.actions[0].source, { type: 'tab', key: 't12' });
  assert.equal(p.actions[0].url, 'https://github.com/stevearc/oil.nvim');
  clean(p);
});

test('G21 move b11 under w2 → new-tab(from b11) + delete-bookmark b11', () => {
  const p = run(moveLine(EXAMPLE, 'b11', 't22', 2));
  assert.deepEqual(kinds(p), ['new-tab', 'delete-bookmark']);
  assert.deepEqual(p.actions[0].source, { type: 'bookmark', key: 'b11' });
  assert.equal(p.actions[0].url, 'https://github.com/');
  assert.equal(p.actions[0].window, 'w2');
  assert.equal(p.actions[1].key, 'b11');
  clean(p);
});

test('G22 copy the b10 block to the top level → new-window + 2 new-tab, original kept', () => {
  const text = `${EXAMPLE}\n\n${block(EXAMPLE, 'b10').map((l) => l.slice(2)).join('\n')}`;
  const p = run(text);
  assert.deepEqual([...kinds(p)].sort(), ['new-tab', 'new-tab', 'new-window']);
  assert.deepEqual(ofKind(p, 'new-tab').map((a) => a.url), ['https://github.com/', 'https://developer.mozilla.org/']);
  assert.ok(ofKind(p, 'new-tab').every((a) => a.source.type === 'bookmark'));
  clean(p);
});

test('G23 copy the w2 block under the bar, indented → new-folder "Window 2" + 2 new-bookmark, w2 kept', () => {
  const text = insertAfter(EXAMPLE, 'b13', reindent(block(EXAMPLE, 'w2'), 2));
  const p = run(text);
  assert.deepEqual(kinds(p), ['new-folder', 'new-bookmark', 'new-bookmark']);
  assert.equal(p.actions[0].title, 'Window 2');
  assert.equal(p.actions[0].parent, 'b1');
  assert.deepEqual(ofKind(p, 'new-bookmark').map((a) => [a.title, a.url, a.parent === p.actions[0].key]),
    [['tmux-oil', 'https://github.com/minhyeoky/tmux-oil.nvim', true], ['CodeMirror', 'https://codemirror.net/', true]]);
  clean(p);
});

test('G24a top-level entry → error', () => {
  const p = run(`${EXAMPLE}\n\nhttps://x.test/`);
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0].message, /top-level entry/);
});

test('G24b folder inside a group → error', () => {
  const p = run(insertAfter(EXAMPLE, 't14', ['    nested/']));
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0].message, /groups cannot nest/);
});

test('G24c delete the b2 root line → error', () => {
  const p = run(del(EXAMPLE, 'b2'));
  assert.ok(p.errors.some((e) => /bookmark root "Other bookmarks"/.test(e.message)));
});

test('G24d new bookmark without a URL → error', () => {
  const p = run(insertAfter(EXAMPLE, 'b13', ['    Just a title']));
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0].message, /needs a URL/);
});

test('G25 unknown anchor /t99 under w2 → new-tab foo.test + warning', () => {
  const text = insertAfter(EXAMPLE, 't22', ['  /t99 Foo https://foo.test/']);
  const p = run(text);
  assert.deepEqual(kinds(p), ['new-tab']);
  assert.equal(p.actions[0].url, 'https://foo.test/');
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0].message, /unknown anchor \/t99/);
  assert.deepEqual(p.errors, []);
});

test('G26 buffer untouched, F gained t30 and lost t22 → no actions, warning on the t22 line', () => {
  const F = baseSnapshot();
  const w2 = F.windows[1];
  w2.tabs = [w2.tabs[0], { id: 30, index: 1, title: 'Fresh', url: 'https://fresh.test/', pinned: false, active: false, groupId: -1 }];
  const p = run(EXAMPLE, { fresh: F });
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, [{ line: lineNo(EXAMPLE, 't22'), message: 'gone — skipped' }]);
});

test('G27 pinned t11 moved behind t12 → warning, pinned stays first, no actions', () => {
  const base = baseSnapshot();
  base.windows[0].tabs[0].pinned = true;
  const text = moveLine(renderS(base), 't11', 't12', 2);
  const p = run(text, { base, fresh: base });
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.warnings.map((w) => w.message), ['pinned tabs stay first']);
  assert.deepEqual(winItems(p, 'w1')[0], 't11');
});

test('G28 complex snapshot: render → parse → plan is empty', async () => {
  const { complexSnapshot } = await import('./properties.helpers.js');
  const snap = complexSnapshot();
  const p = run(renderS(snap), { base: snap, fresh: snap });
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, []);
});

// ── extra cases beyond G1–G28 ───────────────────────────────────────────────

test('a copied folder block is new even when the copy comes first in the document', () => {
  // copy of Dev pasted into Other bookmarks (below) → original stays in the bar
  const below = run(insertAfter(EXAMPLE, 'b2', block(EXAMPLE, 'b10')));
  assert.deepEqual([...kinds(below)].sort(), ['new-bookmark', 'new-bookmark', 'new-folder']);
  assert.ok(below.actions.every((a) => a.kind.startsWith('new-')), 'nothing moved or deleted');
  // copy pasted ABOVE the original, directly under the bar line: the originals are still the lines under the b10 anchor
  // whose parent line is the bar (b1); the pasted block (parent line is also the bar) comes first, so the exact-copy
  // rule applies: first in document order wins. Either way nothing is deleted and the final tree has two Dev folders.
  const above = run(insertAfter(EXAMPLE, 'b1', block(EXAMPLE, 'b10')));
  assert.ok(above.actions.every((a) => !a.kind.startsWith('delete-') && a.kind !== 'close-tab'), 'nothing deleted');
  assert.equal(ofKind(above, 'new-folder').length + ofKind(above, 'move-folder').length, 1);
});

test('a copy under a different parent never steals the original (parent anchor decides)', () => {
  // copy of Dev placed under Other bookmarks, ABOVE Wikipedia: parent anchor b2 ≠ base parent b1 → copy
  const p = run(insertAfter(EXAMPLE, 'b2', block(EXAMPLE, 'b10')));
  assert.equal(ofKind(p, 'new-folder')[0].parent, 'b2');
  assert.ok(!kinds(p).includes('move-folder'));
});

test('moving a group line with its members to another window → move-group only', () => {
  const text = insertAfter(delBlock(EXAMPLE, 'g5'), 't22', reindent(block(EXAMPLE, 'g5'), 0));
  const p = run(text);
  assert.deepEqual(kinds(p), ['move-group']);
  assert.equal(p.actions[0].window, 'w2');
  assert.deepEqual(winItems(p, 'w2'), ['t21', 't22', 'g5:t13,t14']);
  clean(p);
});

test('reordering members inside a group → reorder g5', () => {
  const p = run(moveLine(EXAMPLE, 't14', 'g5', 4));
  assert.deepEqual(kinds(p), ['reorder']);
  assert.equal(p.actions[0].parent, 'g5');
});

test('reordering inside a bookmark folder → reorder', () => {
  const p = run(moveLine(EXAMPLE, 'b12', 'b10', 4));
  assert.deepEqual(kinds(p), ['reorder']);
  assert.equal(p.actions[0].parent, 'b10');
});

test('window block moved to a bookmark folder (no copy) closes its tabs and keeps window out of the picture', () => {
  const moved = insertAfter(delBlock(EXAMPLE, 'w2'), 'b13', reindent(block(EXAMPLE, 'w2'), 2));
  const p = run(moved);
  assert.deepEqual([...kinds(p)].sort(), ['close-tab', 'close-tab', 'new-bookmark', 'new-bookmark', 'new-folder']);
});

test('bookmark folder block moved to the top level → new-window, tabs from bookmarks, delete-folder', () => {
  const text = `${delBlock(EXAMPLE, 'b10')}\n\n${block(EXAMPLE, 'b10').map((l) => l.slice(2)).join('\n')}`;
  const p = run(text);
  assert.deepEqual([...kinds(p)].sort(), ['delete-folder', 'new-tab', 'new-tab', 'new-window']);
  assert.equal(ofKind(p, 'delete-folder')[0].count, 2);
});

test('an F-only bookmark inside a folder that is being deleted blocks the plan', () => {
  const F = baseSnapshot();
  F.bookmarks[0].children[0].children.push({ id: '99', title: 'Surprise', url: 'https://surprise.test/' });
  const p = run(delBlock(EXAMPLE, 'b10'), { fresh: F });
  assert.ok(p.errors.some((e) => /new contents outside/.test(e.message)));
});

test('a line whose desired parent vanished outside is an error; the parent line is a warning', () => {
  const F = baseSnapshot();
  F.windows = [F.windows[0]]; // w2 closed, and its tabs with it
  const p = run(insertAfter(EXAMPLE, 't22', ['  https://new.test/']), { fresh: F });
  assert.ok(p.warnings.some((w) => w.message === 'gone — skipped'));
  assert.ok(p.errors.some((e) => /parent was closed outside/.test(e.message)));
});

test('deleting a line for an entity that already vanished is silent', () => {
  const F = baseSnapshot();
  F.windows[0].tabs = F.windows[0].tabs.filter((t) => t.id !== 15);
  const p = run(del(EXAMPLE, 't15'), { fresh: F });
  assert.deepEqual(p.actions, []);
  clean(p);
});

test('external navigation is not undone: content compares against S, not F', () => {
  const F = baseSnapshot();
  F.windows[0].tabs[1].url = 'https://elsewhere.test/';
  const p = run(EXAMPLE, { fresh: F });
  assert.deepEqual(p.actions, []);
  clean(p);
});

test('external move is undone: position compares against F', () => {
  const F = baseSnapshot();
  // t22 moved by hand into w1 while the buffer still says w2
  const [t22] = F.windows[1].tabs.splice(1, 1);
  F.windows[0].tabs.push({ ...t22, index: 5 });
  const p = run(EXAMPLE, { fresh: F });
  assert.deepEqual(kinds(p), ['move-tab']);
  assert.equal(p.actions[0].key, 't22');
  assert.equal(p.actions[0].window, 'w2');
});

test('anchored empty lines keep values: tab keeps URL, bookmark title becomes empty', () => {
  const t = run(replaceLine(EXAMPLE, 't12', '  /t12 '));
  assert.deepEqual(t.actions, []);
  clean(t);
  const b = run(replaceLine(EXAMPLE, 'b11', '    /b11 '));
  assert.deepEqual(kinds(b), ['edit-bookmark']);
  assert.deepEqual(b.actions[0].changes, { title: '' });
});

test('bookmark URL edit and folder rename', () => {
  const p = run(replaceLine(replaceLine(EXAMPLE, 'b12', '    /b12 MDN https://developer.mozilla.org/en-US/'), 'b13', '  /b13 Later/'));
  assert.deepEqual([...kinds(p)].sort(), ['edit-bookmark', 'edit-folder']);
  assert.deepEqual(ofKind(p, 'edit-bookmark')[0].changes, { url: 'https://developer.mozilla.org/en-US/' });
  assert.deepEqual(ofKind(p, 'edit-folder')[0].changes, { title: 'Later' });
});

test('window and root names are ignored', () => {
  const p = run(replaceLine(replaceLine(EXAMPLE, 'w1', '/w1 Whatever/'), 'b2', '/b2 Renamed root/'));
  assert.deepEqual(p.actions, []);
  clean(p);
});

test('a new tab line pasted from a closed tab (stale anchor) reopens it with a warning', () => {
  const F = baseSnapshot();
  F.windows[0].tabs = F.windows[0].tabs.filter((t) => t.id !== 15);
  const base = F; // buffer rendered after the tab was closed
  const text = insertAfter(renderS(base), 't12', ['  /t15 Hacker News https://news.ycombinator.com/']);
  const p = run(text, { base, fresh: base });
  assert.deepEqual(kinds(p), ['new-tab']);
  assert.equal(p.warnings.length, 1);
});

test('a pinned tab inside a group is taken out of it with a warning', () => {
  const base = baseSnapshot();
  base.windows[0].tabs[0].pinned = true; // t11
  const text = insertAfter(delBlock(renderS(base), 't11'), 't14', ['    /t11 Neovim https://neovim.io/']);
  const p = run(text, { base, fresh: base });
  assert.ok(p.warnings.some((w) => /can't be grouped/.test(w.message)));
  assert.deepEqual(winItems(p, 'w1')[0], 't11');
  assert.deepEqual(p.actions, []);
});

test('a new window without tabs is skipped with a warning', () => {
  const p = run(`${EXAMPLE}\n\nempty/`);
  assert.deepEqual(p.actions, []);
  assert.ok(p.warnings.some((w) => /no tabs/.test(w.message)));
});

test('duplicate window line is a copy: new window with new tabs', () => {
  const text = `${EXAMPLE}\n\n${block(EXAMPLE, 'w2').join('\n')}`;
  const p = run(text);
  assert.deepEqual([...kinds(p)].sort(), ['new-tab', 'new-tab', 'new-window']);
});

test('lines of an invalid subtree produce one error, not an avalanche', () => {
  const text = insertAfter(EXAMPLE, 't14', ['    nested/', '      deeper/', '        https://x.test/']);
  const p = run(text);
  assert.equal(p.errors.length, 1);
});

test('marks: new, copy, move, navigate, edit appear on the right lines', () => {
  const text = replaceLine(insertAfter(moveLine(EXAMPLE, 't12', 't22', 2), 't22', ['  https://example.com/']), 't15', '  /t15 Hacker News https://news.ycombinator.com/x');
  const p = run(text);
  const byLine = (n) => p.marks.filter((m) => m.line === n).map((m) => m.text);
  const ls = linesOf(text);
  const idx = (key) => ls.findIndex((l) => l.includes(`/${key} `));
  assert.deepEqual(byLine(idx('t12')), ['→ Window 2']);
  assert.deepEqual(byLine(idx('t15')), ['↻ navigate']);
  assert.ok(ls.findIndex((l) => l.includes('example.com')) >= 0);
  assert.deepEqual(byLine(ls.findIndex((l) => l.includes('example.com'))), ['+ new']);
});

// ── group line → bookmark folder ────────────────────────────────────────────

test('a group block copied under a bookmark folder → new folder titled without ` [color]`, tabs become bookmarks, group kept', () => {
  const p = run(insertAfter(EXAMPLE, 'b13', reindent(block(EXAMPLE, 'g5'), 2)));
  assert.deepEqual(kinds(p), ['new-folder', 'new-bookmark', 'new-bookmark']);
  const nf = ofKind(p, 'new-folder')[0];
  assert.equal(nf.title, 'Research');
  assert.equal(nf.parent, 'b13');
  assert.equal(nf.label, '+ folder Research → Bookmarks bar/Read later');
  assert.ok(ofKind(p, 'new-bookmark').every((a) => a.parent === nf.key && a.source.type === 'tab'));
  clean(p);
});

test('a group block moved under a bookmark folder → the folder is titled without ` [color]`, the group is dissolved and its tabs close', () => {
  const p = run(insertAfter(delBlock(EXAMPLE, 'g5'), 'b13', reindent(block(EXAMPLE, 'g5'), 2)));
  assert.deepEqual([...kinds(p)].sort(), ['close-tab', 'close-tab', 'new-bookmark', 'new-bookmark', 'new-folder', 'remove-group']);
  assert.equal(ofKind(p, 'new-folder')[0].title, 'Research');
  clean(p);
});

test('a group line without a title turns into an untitled folder', () => {
  const p = run(insertAfter(EXAMPLE, 'b13', ['    /g5 [blue]/']));
  assert.equal(ofKind(p, 'new-folder')[0].title, '');
});

test('a folder line typed by hand under bookmarks keeps its literal name, `[color]` included', () => {
  const p = run(insertAfter(EXAMPLE, 'b13', ['    Research [blue]/']));
  assert.deepEqual(kinds(p), ['new-folder']);
  assert.equal(p.actions[0].title, 'Research [blue]');
  clean(p);
});

test('renaming a bookmark folder to something ending in `[color]` keeps the literal name', () => {
  const p = run(replaceLine(EXAMPLE, 'b13', '  /b13 Later [blue]/'));
  assert.deepEqual(kinds(p), ['edit-folder']);
  assert.deepEqual(p.actions[0].changes, { title: 'Later [blue]' });
});
