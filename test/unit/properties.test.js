// Property-style tests: render → parse → plan is empty (identity), and the grammar round-trips awkward values.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine, normalizeTitle, normalizeUrl, splitGroupName, folderContent, groupContent, entryContent } from '../../src/core/grammar.js';
import { parseText } from '../../src/core/parse.js';
import { render } from '../../src/core/render.js';
import { plan } from '../../src/core/plan.js';
import { NASTY_TITLES, complexSnapshot, randomSnapshot, randomTitle, randomUrl, rng } from './properties.helpers.js';

test('property: render → parse → plan is empty for 300 random snapshots', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const snap = randomSnapshot(seed);
    const { text } = render(snap);
    const p = plan(snap, snap, text);
    assert.deepEqual(p.errors, [], `errors, seed ${seed}\n${text}`);
    assert.deepEqual(p.warnings, [], `warnings, seed ${seed}\n${text}`);
    assert.deepEqual(p.actions, [], `actions, seed ${seed}\n${text}\n${JSON.stringify(p.actions, null, 1)}`);
  }
});

test('property: the identity also holds against a fresh snapshot that equals the base', () => {
  for (let seed = 1000; seed < 1100; seed++) {
    const snap = randomSnapshot(seed);
    const { text } = render(snap);
    const p = plan(snap, JSON.parse(JSON.stringify(snap)), text);
    assert.deepEqual(p.actions, []);
    assert.deepEqual(p.errors, []);
  }
});

test('property: every awkward title survives a window/group/folder/entry line round trip', () => {
  const r = rng(7);
  const titles = [...NASTY_TITLES, ...Array.from({ length: 300 }, () => randomTitle(r))];
  for (const raw of titles) {
    const title = normalizeTitle(raw);

    const f = parseLine(`/b1 ${folderContent(title)}`);
    assert.equal(f.type, 'folder', JSON.stringify(title));
    assert.equal(f.name, title, `folder ${JSON.stringify(title)} → ${JSON.stringify(folderContent(title))}`);

    for (const color of ['blue', 'grey']) {
      const g = parseLine(`/g1 ${groupContent(title, color)}`);
      assert.equal(g.type, 'folder', JSON.stringify(title));
      assert.deepEqual(splitGroupName(g.name), { title, color }, `group ${JSON.stringify(title)}`);
    }

    const url = normalizeUrl(randomUrl(r)) || 'about:blank';
    const e = parseLine(`/t1 ${entryContent(title, url)}`);
    assert.equal(e.type, 'entry', JSON.stringify(title));
    assert.equal(e.title, title);
    assert.equal(e.url, url);
  }
});

test('normalisation: whitespace runs collapse, URL spaces become %20', () => {
  assert.equal(normalizeTitle('  a \n\t b  '), 'a b');
  assert.equal(normalizeUrl('https://x.test/a b\tc'), 'https://x.test/a%20b%20c');
  assert.equal(normalizeUrl(''), '');
});

test('a folder titled `foo/` renders as `foo//` and parses back', () => {
  assert.equal(folderContent('foo/'), 'foo//');
  assert.equal(parseLine('/b1 foo//').name, 'foo/');
});

test('a folder whose last token looks like a URL gets an escape space', () => {
  assert.equal(folderContent('Re:'), 'Re: /');
  assert.equal(parseLine('/b1 Re: /').name, 'Re:');
  assert.equal(parseLine('/b1 Re: /').type, 'folder');
  // as an unescaped line it is an entry with a URL, which is why the escape exists
  assert.equal(parseLine('/b1 Re:/').type, 'entry');
});

test('group colors: only a trailing [color] is a color', () => {
  assert.deepEqual(splitGroupName('Research [blue]'), { title: 'Research', color: 'blue' });
  assert.deepEqual(splitGroupName('[blue]'), { title: '', color: 'blue' });
  assert.deepEqual(splitGroupName('x[blue]'), { title: 'x[blue]', color: null });
  assert.deepEqual(splitGroupName('[blue] x'), { title: '[blue] x', color: null });
  assert.deepEqual(splitGroupName('a [teal]'), { title: 'a [teal]', color: null });
});

test('anchor is read only at the start of the line, after the indent', () => {
  const a = parseLine('    /t12 hi https://x.test/');
  assert.deepEqual([a.indent, a.anchor.kind, a.anchor.id, a.title, a.url], [4, 't', '12', 'hi', 'https://x.test/']);
  const b = parseLine('  hi /t12 https://x.test/');
  assert.equal(b.anchor, null);
  assert.equal(parseLine('  /t12').anchor.id, '12');
  assert.equal(parseLine('  /t12').type, 'empty');
  assert.equal(parseLine('  /t12x foo').anchor, null);
  assert.equal(parseLine('\t/t12 x').indent, 2);
  assert.equal(parseLine('   '), null);
});

test('parent rule: nearest preceding folder with a smaller indent; entries are never parents', () => {
  const { lines } = parseText([
    'A/',
    '    B/',
    '  e1',
    '      x',
    'C/',
    '  y',
  ].join('\n'));
  const parentName = (i) => (lines[i].parent >= 0 ? lines[lines[i].parent].name ?? lines[lines[i].parent].title : null);
  assert.equal(parentName(0), null);
  assert.equal(parentName(1), 'A'); // B
  assert.equal(parentName(2), 'A'); // e1 (indent 2): B (indent 4) is not smaller
  assert.equal(parentName(3), 'B'); // x (indent 6): B is the nearest preceding folder with indent < 6, entries skipped
  assert.equal(parentName(4), null); // C
  assert.equal(parentName(5), 'C');
});

test('complex snapshot renders to something the grammar reads back unchanged', () => {
  const snap = complexSnapshot();
  const { text, lines } = render(snap);
  const parsed = parseText(text).lines;
  assert.equal(parsed.length, lines.filter((l) => l.kind !== 'blank').length);
  for (const [i, L] of parsed.entries()) {
    const meta = lines.filter((l) => l.kind !== 'blank')[i];
    assert.equal(`${L.anchor.kind}${L.anchor.id}`, meta.key);
    assert.equal(L.indent, meta.indent);
  }
});
