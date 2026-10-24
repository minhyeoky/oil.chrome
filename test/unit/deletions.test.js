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

// ── bookmarks moved outside between render and :w ───────────────────────────
// removeTree acts on the live tree (F), so what a delete-folder takes along, and whether a deleted entity needs an
// action of its own, is read off F: a bookmark that sits elsewhere in F is not taken with the folder it used to be in.

/** A copy of `snap` where bookmark `id` was moved, outside, to the end of folder `parentId`. */
function moved(snap, id, parentId) {
  const copy = JSON.parse(JSON.stringify(snap));
  let node = null;
  const take = (n) => (n.children || []).some((c, i) => {
    if (c.id === id) { [node] = n.children.splice(i, 1); return true; }
    return take(c);
  });
  const put = (n) => { if (n.id === parentId) { n.children.push(node); return true; } return (n.children || []).some(put); };
  copy.bookmarks.some(take);
  assert.ok(node && copy.bookmarks.some(put), `no bookmark ${id} / folder ${parentId}`);
  return copy;
}
const noErrors = (p) => assert.deepEqual([p.errors, p.warnings], [[], []]);
const DEV_BLOCK = delBlock(TEXT, 'b10'); // Dev, GitHub, MDN, Mid, Sub, X, Y, Z: 8 lines

test('a bookmark moved out of a deleted folder outside is its own deletion; the folder tallies what is left in it', () => {
  const F = moved(NESTED, '11', '13'); // GitHub: Dev → Read later
  const p = go(DEV_BLOCK, F); // the Dev block still holds GitHub's line
  assert.deepEqual(kinds(p), ['delete-folder', 'delete-bookmark']);
  assert.deepEqual(ofKind(p, 'delete-bookmark').map((a) => a.key), ['b11']);
  assert.deepEqual(folderActs(p), [['b10', 4, 2]]); // MDN X Y Z, Mid Sub
  assert.match(p.actions[0].label, /\(4 bookmarks\)/);
  assert.equal(deletionCount(p.actions), 8); // the 8 lines of the block, once each
  noErrors(p);
});

test('a deleted folder moved out of a deleted folder outside is its own deletion with its own tally', () => {
  const F = moved(NESTED, '14', '13'); // Mid (Sub X Y, Z): Dev → Read later
  const p = go(DEV_BLOCK, F);
  assert.deepEqual(kinds(p), ['delete-folder', 'delete-folder']);
  assert.deepEqual(folderActs(p), [['b10', 2, 0], ['b14', 3, 1]]); // Dev: GitHub MDN. Mid: X Y Z, Sub
  assert.equal(deletionCount(p.actions), 8);
  noErrors(p);
});

test('a bookmark moved into a deleted folder outside, its own line gone, is deleted with the folder', () => {
  const F = moved(NESTED, '20', '10'); // Wikipedia: Other bookmarks → Dev
  const p = go(del(DEV_BLOCK, 'b20'), F);
  assert.deepEqual(kinds(p), ['delete-folder']);
  assert.deepEqual(folderActs(p), [['b10', 6, 2]]); // GitHub MDN X Y Z Wikipedia, Mid Sub
  assert.ok(p.actions[0].known.includes('b20'), 'the re-check before removeTree must expect it');
  assert.equal(deletionCount(p.actions), 9); // the 8 lines of the block and Wikipedia
  noErrors(p);
});

test('still moved back and not deleted: a bookmark moved into a deleted folder outside whose line is kept', () => {
  const F = moved(NESTED, '20', '10');
  const p = go(DEV_BLOCK, F); // Wikipedia's line is still under Other bookmarks
  assert.deepEqual(kinds(p), ['move-bookmark', 'delete-folder']);
  assert.deepEqual([p.actions[0].key, p.actions[0].parent], ['b20', 'b2']);
  assert.deepEqual(folderActs(p), [['b10', 5, 2]]);
  assert.equal(deletionCount(p.actions), 8);
  noErrors(p);
});

test('a deleted bookmark moved into another deleted folder outside is counted there, and has no action of its own', () => {
  const F = moved(NESTED, '16', '13'); // X: Sub → Read later
  const p = go(del(DEV_BLOCK, 'b13'), F); // the Dev block and the Read later line go
  assert.deepEqual(kinds(p), ['delete-folder', 'delete-folder']);
  assert.deepEqual(folderActs(p), [['b10', 4, 2], ['b13', 1, 0]]); // Dev: GitHub MDN Y Z, Mid Sub. Read later: X
  assert.equal(deletionCount(p.actions), 9); // the 8 lines of the block and Read later
  noErrors(p);
});

test('a deleted bookmark moved into a folder created outside is deleted there; the new folder stays', () => {
  const F = moved(NESTED, '11', '13');
  F.bookmarks[0].children[1].children.push({ id: '99', title: 'Outside', children: [F.bookmarks[0].children[1].children.shift()] });
  const p = go(DEV_BLOCK, F); // GitHub now sits in "Outside" under Read later
  assert.deepEqual(kinds(p), ['delete-folder', 'delete-bookmark']);
  assert.deepEqual(ofKind(p, 'delete-bookmark').map((a) => a.key), ['b11']);
  assert.deepEqual(folderActs(p), [['b10', 4, 2]]);
  assert.equal(deletionCount(p.actions), 8);
  noErrors(p);
});

/** The nested snapshot with a bookmark added, outside, to folder `folderId`. */
function withSurprise(folderId) {
  const copy = nestedSnapshot();
  const put = (n) => {
    if (n.id === folderId) { n.children.push({ id: '99', title: 'Surprise', url: 'https://surprise.test/' }); return true; }
    return (n.children || []).some(put);
  };
  assert.ok(copy.bookmarks.some(put), `no folder ${folderId}`);
  return copy;
}
const blocked = (title) => [`folder "${title}" got new contents outside — :e! to reload`];

test('a bookmark added outside in a folder that stays does not block the delete: the folder moves out first', () => {
  const p = go(del(TEXT, 'b10'), withSurprise('14')); // only the Dev line goes: GitHub, MDN and Mid (with Surprise) move up
  assert.deepEqual(kinds(p), ['move-bookmark', 'move-bookmark', 'move-folder', 'delete-folder']);
  assert.deepEqual(folderActs(p), [['b10', 0, 0]]);
  noErrors(p);
  // deeper: Dev and Mid go, Sub (with X, Y and Surprise) stays and moves up
  const q = go(del(del(TEXT, 'b10'), 'b14'), withSurprise('15'));
  assert.deepEqual(folderActs(q), [['b10', 0, 1]]);
  noErrors(q);
  // Sub is deleted on its own and refuses what was added in it; Dev, whose removeTree does not reach Sub, says nothing
  const own = go(delBlock(del(TEXT, 'b10'), 'b15'), withSurprise('15'));
  assert.deepEqual(own.errors.map((e) => e.message), blocked('Sub'));
});

test('still blocks: a bookmark added outside in a deleted folder, in a deleted subfolder of it, or in one deleted on its own', () => {
  assert.deepEqual(go(DEV_BLOCK, withSurprise('10')).errors.map((e) => e.message), blocked('Dev'));
  assert.deepEqual(go(DEV_BLOCK, withSurprise('15')).errors.map((e) => e.message), blocked('Dev')); // in Sub
  const own = go(delBlock(del(TEXT, 'b10'), 'b15'), withSurprise('15')); // Dev line and Sub block go; Sub is a delete of its own
  assert.ok(own.errors.some((e) => e.message === blocked('Sub')[0]));
});

test('still no plan error for a bookmark moved out of or into a deleted folder outside (only added content blocks)', () => {
  noErrors(go(DEV_BLOCK, moved(NESTED, '11', '13')));
  noErrors(go(del(DEV_BLOCK, 'b20'), moved(NESTED, '20', '10')));
});

test('known: a delete-folder expects the folder and what it takes along, not what is kept or moved out', () => {
  const F = moved(NESTED, '11', '13'); // GitHub: Dev → Read later
  const whole = go(DEV_BLOCK, F).actions.find((a) => a.key === 'b10');
  assert.deepEqual([...whole.known].sort(), ['b10', 'b12', 'b14', 'b15', 'b16', 'b17', 'b18']); // not GitHub (b11)
  const lineOnly = go(del(TEXT, 'b10')).actions.find((a) => a.key === 'b10'); // GitHub, MDN and Mid move up to the bar
  assert.deepEqual(lineOnly.known, ['b10']);
});
