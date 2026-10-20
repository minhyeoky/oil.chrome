// Deletion counts: the `(n bookmarks)` of a delete-folder label and the "✕ N deletions" of the confirmation.
// The count is the number of entities a write removes: tabs closed + bookmarks deleted + folders deleted (nested ones
// included). Every case below states which lines went, because that is what a person checks the number against.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from '../../src/core/render.js';
import { deletionCount } from '../../src/core/plan.js';
import { EXAMPLE, baseSnapshot, del, delBlock, kinds, ofKind, run } from './fixtures.js';

/** The §2 example with Dev holding more: Dev ⊃ GitHub, MDN, Mid ⊃ (Sub ⊃ X, Y), Z. */
function nestedSnapshot() {
  const snap = baseSnapshot();
  snap.bookmarks[0].children[0].children.push({
    id: '14', title: 'Mid', children: [
      { id: '15', title: 'Sub', children: [{ id: '16', title: 'X', url: 'https://x.test/' }, { id: '17', title: 'Y', url: 'https://y.test/' }] },
      { id: '18', title: 'Z', url: 'https://z.test/' },
    ],
  });
  return snap;
}
const NESTED = nestedSnapshot();
const TEXT = render(NESTED).text;
const go = (text, fresh = NESTED) => run(text, { base: NESTED, fresh });
const folderActs = (p) => ofKind(p, 'delete-folder').map((a) => [a.key, a.count, a.folders]);

test('a flat folder block: the folder plus its bookmarks (G15b)', () => {
  const p = run(delBlock(EXAMPLE, 'b10'));
  assert.deepEqual(folderActs(p), [['b10', 2, 0]]);
  assert.equal(deletionCount(p.actions), 3); // Dev, GitHub, MDN
});

test('a nested block is one action; every bookmark and every nested folder in it counts once', () => {
  const p = go(delBlock(TEXT, 'b10'));
  assert.deepEqual(kinds(p), ['delete-folder']);
  assert.deepEqual(folderActs(p), [['b10', 5, 2]]); // bookmarks GitHub MDN X Y Z, folders Mid Sub
  assert.match(p.actions[0].label, /\(5 bookmarks\)/);
  assert.equal(deletionCount(p.actions), 8); // the 8 lines of the Dev block
});

test('bookmarks and folders moved out of a deleted folder are not deletions', () => {
  const p = go(del(TEXT, 'b10')); // only the Dev line goes; GitHub, MDN and Mid move up to the bar
  assert.deepEqual(kinds(p), ['move-bookmark', 'move-bookmark', 'move-folder', 'delete-folder']);
  assert.deepEqual(folderActs(p), [['b10', 0, 0]]);
  assert.equal(deletionCount(p.actions), 1);
});

test('a deleted folder inside a deleted folder is one action and still a deletion', () => {
  const p = go(del(del(TEXT, 'b10'), 'b14')); // Dev and Mid go; GitHub, MDN, Sub (with X, Y) and Z move up
  assert.deepEqual(folderActs(p), [['b10', 0, 1]]);
  assert.equal(deletionCount(p.actions), 2);
});

test('what is deleted below a folder that stays is its own action, not part of the deleted ancestor', () => {
  // Dev goes and Mid moves up to the bar, but the Sub block (Sub, X, Y) is deleted inside Mid
  const p = go(delBlock(del(TEXT, 'b10'), 'b15'));
  assert.deepEqual(folderActs(p), [['b10', 0, 0], ['b15', 2, 0]]);
  assert.match(p.actions.find((a) => a.key === 'b10').label, /\(0 bookmarks\)/);
  assert.equal(deletionCount(p.actions), 4); // Dev, Sub, X, Y — not 6
});

test('a bookmark deleted inside a folder that stays is counted once, beside the deleted ancestor', () => {
  const p = go(del(del(TEXT, 'b10'), 'b16')); // Dev and X go; Mid, Sub and Y stay
  assert.deepEqual(kinds(p).filter((k) => k.startsWith('delete-')).sort(), ['delete-bookmark', 'delete-folder']);
  assert.deepEqual(folderActs(p), [['b10', 0, 0]]);
  assert.equal(deletionCount(p.actions), 2); // Dev, X — not 3
});

test('a bookmark that already vanished outside is not counted', () => {
  const F = nestedSnapshot();
  F.bookmarks[0].children[0].children[2].children[0].children.shift(); // X gone
  const p = go(delBlock(TEXT, 'b10'), F);
  assert.deepEqual(folderActs(p), [['b10', 4, 2]]);
  assert.equal(deletionCount(p.actions), 7);
});

test('closed tabs and a plain bookmark add one each', () => {
  const p = go(del(del(delBlock(TEXT, 'b10'), 't15'), 'b20'));
  assert.deepEqual([...kinds(p)].sort(), ['close-tab', 'delete-bookmark', 'delete-folder']);
  assert.equal(deletionCount(p.actions), 10); // Hacker News, Wikipedia and the 8 lines of the Dev block
});

test('dropping a group line only ungroups: it is not a deletion (G12)', () => {
  const g = run(del(EXAMPLE, 'g5'));
  assert.deepEqual(kinds(g), ['move-tab', 'move-tab', 'remove-group']);
  assert.equal(deletionCount(g.actions), 0);
});
