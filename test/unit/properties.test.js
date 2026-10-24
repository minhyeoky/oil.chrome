// Property-style tests: render → parse → plan is empty (identity), and the grammar round-trips awkward values.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine, normalizeTitle, normalizeUrl, splitGroupName, folderContent, groupContent, entryContent, bareHostUrl, withScheme } from '../../src/core/grammar.js';
import { parseText } from '../../src/core/parse.js';
import { render } from '../../src/core/render.js';
import { plan } from '../../src/core/plan.js';
import { HOST_PORT_TITLES, NASTY_TITLES, complexSnapshot, randomSnapshot, randomTitle, randomUrl, rng } from './properties.helpers.js';

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
  const titles = [...NASTY_TITLES, ...HOST_PORT_TITLES, ...Array.from({ length: 300 }, () => randomTitle(r))];
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

test('withScheme: a host:port token gets http (localhost, *.localhost, IPv4) or https (other hosts); other URLs pass', () => {
  assert.equal(withScheme('localhost:3000'), 'http://localhost:3000');
  assert.equal(withScheme('app.localhost:5173/x'), 'http://app.localhost:5173/x');
  assert.equal(withScheme('LocalHost:3000/'), 'http://LocalHost:3000/');
  assert.equal(withScheme('example.com:8080?q=1#f'), 'https://example.com:8080?q=1#f');
  for (const u of ['https://localhost:3000/', 'tel:123', 'mailto:a@b.c', 'about:blank', 'chrome://settings', 'javascript:void(0)', 'localhost:abc', 'devbox:3000']) {
    assert.equal(withScheme(u), u, u);
  }
});

test('bareHostUrl: a lone bare host on a new tab line; localhost and IPv4 open over http, other hosts over https', () => {
  const url = (s) => bareHostUrl(parseLine(`  ${s}`));
  assert.equal(url('localhost'), 'http://localhost');
  assert.equal(url('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(url('192.168.0.1'), 'http://192.168.0.1');
  assert.equal(url('example.com'), 'https://example.com');
  assert.equal(url('localhost.example.com'), 'https://localhost.example.com');
  assert.equal(url('127.0.0.1.example.com'), 'https://127.0.0.1.example.com');
  // `localhost:3000` is a URL token, so it is not a bare host: withScheme handles it
  for (const s of ['hello world', 'localhost:3000', 'example.com:8080', 'tel:123', 'Re:', 'foo.c']) assert.equal(url(s), null, s);
});

test('`example.com/` and `localhost:3000/` are read the way their last token reads: a folder, and a URL', () => {
  assert.deepEqual([parseLine('  example.com/').type, parseLine('  example.com/').name], ['folder', 'example.com']);
  assert.deepEqual([parseLine('  localhost:3000/').type, parseLine('  localhost:3000/').url], ['entry', 'localhost:3000/']);
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

test('an anchor that names a folder keeps its line a folder without the `/`', () => {
  const asked = [];
  const named = new Set(['w1', 'g5', 'b10']);
  const isFolderKey = (k) => { asked.push(k); return named.has(k); };
  const read = (raw, opts) => { const p = parseLine(raw, opts); return p.type === 'folder' ? `folder:${p.name}` : p.type; };
  // named by the snapshot, whatever the kind
  for (const [raw, expected] of [
    ['/w1 ', 'folder:'], ['/w1 Whatever', 'folder:Whatever'], ['/w1 /', 'folder:'],
    ['/g5 ', 'folder:'], ['/g5 Papers [red]', 'folder:Papers [red]'], ['/g5 [red]', 'folder:[red]'], ['  /g5 Re: ', 'folder:Re:'],
    ['/b10 ', 'folder:'], ['/b10 Tools', 'folder:Tools'], ['/b10 Tools/', 'folder:Tools'], ['/b10 Tools//', 'folder:Tools/'],
  ]) assert.equal(read(raw, { isFolderKey }), expected, raw);
  // not named by it (an anchor the snapshot lacks, a bookmark, a tab): the line reads as if it had no anchor
  for (const raw of ['/w99 Foo', '/g99 Foo', '/b99 Foo', '/b11 Foo', '/t12 Foo']) assert.equal(read(raw, { isFolderKey }), 'entry', raw);
  for (const raw of ['/w99 ', '/g99 ', '/b99 ', '/b11 ', '/t12 ']) assert.equal(read(raw, { isFolderKey }), 'empty', raw);
  assert.equal(read('/g99 Foo/', { isFolderKey }), 'folder:Foo', 'a `/` makes a folder whatever the anchor names');
  assert.deepEqual([...new Set(asked)].sort(), ['b10', 'b11', 'b99', 'g5', 'g99', 't12', 'w1', 'w99'], 'asked with the full key, for every kind');
  // without isFolderKey, `w` and `g` anchors name a folder and `b` and `t` anchors do not
  assert.deepEqual(['/w1 ', '/g5 Foo', '/g99 Foo', '/b10 Foo', '/t12 Foo'].map((raw) => read(raw)), ['folder:', 'folder:Foo', 'folder:Foo', 'entry', 'entry']);
  assert.deepEqual(['/b10 ', '/t12 '].map((raw) => read(raw)), ['empty', 'empty']);
});

test('still an entry with a URL token whatever its anchor names; anchorless lines do not depend on isFolderKey', () => {
  const isFolderKey = () => true;
  for (const raw of ['/w1 Win https://x.test/', '/g5 Papers https://x.test/', '/b10 Dev https://x.test/', '/b10 Re:/', '/g5 localhost:3000']) {
    const p = parseLine(raw, { isFolderKey });
    assert.equal(p.type, 'entry', raw);
    assert.ok(p.url, raw);
  }
  for (const [raw, type] of [['Tools', 'entry'], ['Tools/', 'folder'], ['  Re: /', 'folder']]) {
    assert.equal(parseLine(raw, { isFolderKey }).type, type, raw);
  }
});

test('parseText with isFolderKey: the children of a folder line without its `/` stay its children', () => {
  const text = ['/b1 Bar/', '  /b10 Tools', '    /b11 GitHub https://github.com/', '  /b13 ', '    /b14 Later https://l.test/'].join('\n');
  const parentOf = (lines, i) => (lines[i].parent >= 0 ? lines[lines[i].parent].anchor.id : null);
  const plain = parseText(text).lines;
  assert.deepEqual([2, 4].map((i) => parentOf(plain, i)), ['1', '1'], 'without isFolderKey the entry lines are no parents');
  const withS = parseText(text, { isFolderKey: (k) => k === 'b10' || k === 'b13' }).lines;
  assert.deepEqual([1, 2, 3, 4].map((i) => parentOf(withS, i)), ['1', '10', '1', '13']);
  // a stale group anchor is no folder: its members belong to the window, as under an anchorless line
  const stale = ['/w1 Win/', '  /g99 Stale', '    /t2 B https://b.test/', '  /g5 Known', '    /t1 A https://a.test/'].join('\n');
  const lines = parseText(stale, { isFolderKey: (k) => k === 'w1' || k === 'g5' }).lines;
  assert.deepEqual([2, 4].map((i) => parentOf(lines, i)), ['1', '5']);
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
