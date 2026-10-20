// The anchor protection filter and cursor constraint, exercised on a bare EditorState (no DOM needed).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { anchorFilter, anchorSpan, constrainRange } from '../../src/editor/anchors.js';

const DOC = [
  '/w1 Window 1/',
  '  /t11 Neovim https://neovim.io/',
  '  /t12 oil.nvim https://github.com/stevearc/oil.nvim',
  '    /t13 deep https://deep.test/',
  '  /t14 ',
  '',
  '/b1 Bar/',
].join('\n');

const mk = (doc = DOC, sel = 0) => EditorState.create({ doc, selection: { anchor: sel }, extensions: [anchorFilter] });
const lineStart = (st, n) => st.doc.line(n).from;
const apply = (st, spec) => st.update(spec).state;
const textOf = (st) => st.doc.toString();

test('anchorSpan finds anchors after the indent only', () => {
  assert.deepEqual(anchorSpan('  /t11 Neovim'), { a0: 2, a1: 7, kind: 't', id: '11' });
  assert.equal(anchorSpan('  hi /t11 x'), null);
  assert.deepEqual(anchorSpan('/t9'), { a0: 0, a1: 3, kind: 't', id: '9' });
});

test('dd (delete the line with its line break) removes the anchor', () => {
  const st = mk();
  const l = st.doc.line(2);
  const out = apply(st, { changes: { from: l.from, to: l.to + 1 } });
  assert.ok(!textOf(out).includes('/t11'));
  assert.equal(out.doc.lines, st.doc.lines - 1);
});

test('dd on the last line (preceding break goes) removes the anchor', () => {
  const st = mk();
  const l = st.doc.line(7);
  const out = apply(st, { changes: { from: l.from - 1, to: l.to } });
  assert.ok(!textOf(out).includes('/b1'));
});

test('cc / S (replace the line text, keep the break) keeps indent and anchor', () => {
  const st = mk();
  const l = st.doc.line(3);
  const out = apply(st, { changes: { from: l.from, to: l.to } });
  assert.equal(out.doc.line(3).text, '  /t12 ');
});

test('cc then typing: insert after the anchor works', () => {
  let st = mk();
  const l = st.doc.line(3);
  st = apply(st, { changes: { from: l.from, to: l.to } });
  const l2 = st.doc.line(3);
  st = apply(st, { changes: { from: l2.to, insert: 'new title' } });
  assert.equal(st.doc.line(3).text, '  /t12 new title');
});

test('x on the content keeps the anchor; deleting into the anchor is carved around it', () => {
  const st = mk();
  const l = st.doc.line(2);
  // delete [anchor start, +3 chars of name]: spans the anchor end → only the name part goes
  const out = apply(st, { changes: { from: l.from + 2, to: l.from + 7 + 3 } });
  assert.equal(out.doc.line(2).text, '  /t11 vim https://neovim.io/');
  // backspace over the whole atomic anchor is a no-op
  const out2 = apply(st, { changes: { from: l.from + 2, to: l.from + 7 } });
  assert.equal(textOf(out2), DOC);
});

test('D / C style deletions from the cursor to the end of line are untouched', () => {
  const st = mk();
  const l = st.doc.line(2);
  const out = apply(st, { changes: { from: l.from + 7 + 3, to: l.to } });
  assert.equal(out.doc.line(2).text, '  /t11 Neo');
});

test('typing inside or right before an anchor lands behind it', () => {
  const st = mk();
  const l = st.doc.line(2);
  const inside = apply(st, { changes: { from: l.from + 4, insert: 'X' } });
  assert.equal(inside.doc.line(2).text, '  /t11 XNeovim https://neovim.io/');
  const before = apply(st, { changes: { from: l.from + 2, insert: 'X' } });
  assert.equal(before.doc.line(2).text, '  /t11 XNeovim https://neovim.io/');
});

test('indenting with >> (blank text at the line start) is allowed, so is <<', () => {
  const st = mk();
  const l = st.doc.line(2);
  const more = apply(st, { changes: { from: l.from, insert: '  ' } });
  assert.equal(more.doc.line(2).text, '    /t11 Neovim https://neovim.io/');
  const less = apply(more, { changes: { from: l.from, to: l.from + 2 } });
  assert.equal(less.doc.line(2).text, '  /t11 Neovim https://neovim.io/');
});

test('P (whole lines put above) and a blank line above are allowed', () => {
  const st = mk();
  const l = st.doc.line(3);
  const above = apply(st, { changes: { from: l.from, insert: '  /t99 pasted https://p.test/\n' } });
  assert.equal(above.doc.line(3).text, '  /t99 pasted https://p.test/');
  assert.equal(above.doc.line(4).text, '  /t12 oil.nvim https://github.com/stevearc/oil.nvim');
  const blank = apply(st, { changes: { from: l.from, insert: '\n' } });
  assert.equal(blank.doc.line(4).text, '  /t12 oil.nvim https://github.com/stevearc/oil.nvim');
});

test('P above a top-level line (indent 0) keeps both lines whole', () => {
  const st = mk();
  const l = st.doc.line(7);
  const out = apply(st, { changes: { from: l.from, insert: '/b9 pasted/\n' } });
  assert.equal(out.doc.line(7).text, '/b9 pasted/');
  assert.equal(out.doc.line(8).text, '/b1 Bar/');
});

test('p (whole lines put below, inserted at the line end) is allowed', () => {
  const st = mk();
  const l = st.doc.line(3);
  const out = apply(st, { changes: { from: l.to, insert: '\n  /t99 pasted https://p.test/' } });
  assert.equal(out.doc.line(4).text, '  /t99 pasted https://p.test/');
});

test('J (joining onto an anchored line) does not glue the anchor into the previous line', () => {
  const st = mk();
  const l2 = st.doc.line(2);
  const l3 = st.doc.line(3);
  // J on line 2: replace [line2 end, line3 content start-ish (the indent)] with a single space
  const out = apply(st, { changes: { from: l2.to, to: l3.from + 2, insert: ' ' } });
  const t = textOf(out);
  assert.ok(t.split('\n').some((x) => /^\s*\/t12 /.test(x)), 'the t12 anchor still starts its own line');
});

test('a multi-line character deletion keeps the anchor of the partially covered last line', () => {
  const st = mk();
  const l2 = st.doc.line(2);
  const l4 = st.doc.line(4);
  const out = apply(st, { changes: { from: l2.from + 9, to: l4.from + 4 + 5 + 2 } });
  const lines = textOf(out).split('\n');
  assert.ok(lines.some((x) => x.includes('/t13 ')), 'partially covered last line keeps its anchor');
  assert.ok(!lines.some((x) => x.includes('/t12 ')), 'fully covered middle line is gone with its anchor');
});

test('cursor constraint: an empty cursor in [line start, anchor end) moves to the anchor end', () => {
  const st = mk();
  const l = st.doc.line(2);
  for (const pos of [l.from, l.from + 1, l.from + 2, l.from + 5, l.from + 6]) {
    const out = apply(st, { selection: { anchor: pos } });
    assert.equal(out.selection.main.head, l.from + 7, `from ${pos - l.from}`);
  }
  assert.equal(apply(st, { selection: { anchor: l.from + 7 } }).selection.main.head, l.from + 7);
  assert.equal(apply(st, { selection: { anchor: l.from + 12 } }).selection.main.head, l.from + 12);
  // lines without an anchor are free
  const blank = st.doc.line(6);
  assert.equal(apply(st, { selection: { anchor: blank.from } }).selection.main.head, blank.from);
});

test('non-empty selections may cover anchors (visual mode)', () => {
  const st = mk();
  const l = st.doc.line(2);
  const out = apply(st, { selection: EditorSelection.single(l.from, l.to) });
  assert.equal(out.selection.main.from, l.from);
  assert.equal(out.selection.main.to, l.to);
  assert.equal(constrainRange(st.doc, EditorSelection.range(l.from, l.to)).from, l.from);
});

test('after typing, the selection follows the (possibly relocated) insertion', () => {
  const st = mk(DOC, 0);
  const l = st.doc.line(2);
  const out = apply(st, { changes: { from: l.from + 7, insert: 'ab' }, selection: { anchor: l.from + 9 } });
  assert.equal(out.selection.main.head, l.from + 9);
});

test('case changes over a whole line (guu / gUU) leave the anchor exactly as it was', () => {
  const st = mk();
  const l = st.doc.line(3);
  const upper = l.text.toUpperCase();
  const out = apply(st, { changes: { from: l.from, to: l.to, insert: upper } });
  assert.equal(out.doc.line(3).text, '  /t12 OIL.NVIM HTTPS://GITHUB.COM/STEVEARC/OIL.NVIM');
});

test('a multi-line case change keeps every anchor', () => {
  const st = mk();
  const a = st.doc.line(2);
  const b = st.doc.line(3);
  const old = st.doc.sliceString(a.from, b.to);
  const out = apply(st, { changes: { from: a.from, to: b.to, insert: old.toUpperCase() } });
  assert.match(out.doc.line(2).text, /^ {2}\/t11 NEOVIM /);
  assert.match(out.doc.line(3).text, /^ {2}\/t12 OIL\.NVIM /);
});

test('a same-length replacement inside the anchor is dropped (e.g. :s/t/T/)', () => {
  const st = mk();
  const l = st.doc.line(2);
  const out = apply(st, { changes: { from: l.from + 3, to: l.from + 4, insert: 'T' } });
  assert.equal(textOf(out), DOC);
});

test('a longer replacement of anchor text is refused', () => {
  const st = mk();
  const l = st.doc.line(2);
  const out = apply(st, { changes: { from: l.from + 4, to: l.from + 6, insert: '123' } });
  assert.equal(textOf(out), DOC);
});

test('a charwise deletion from mid-line across whole lines into an anchored line does not glue it behind the prefix', () => {
  const st = mk();
  const l2 = st.doc.line(2);
  const l4 = st.doc.line(4);
  const out = apply(st, { changes: { from: l2.from + 7, to: l4.from + 1 } });
  const lines = textOf(out).split('\n');
  assert.ok(lines.some((x) => /^\s*\/t13 /.test(x)), 'the t13 line is untouched');
  assert.ok(!lines.some((x) => /\S\s+\/t\d+ /.test(x.replace(/^\s*\/t\d+ /, ''))), 'no anchor ends up in the middle of a line');
  assert.ok(lines[1].startsWith('  /t11 '), 'the first line keeps its anchor');
});
