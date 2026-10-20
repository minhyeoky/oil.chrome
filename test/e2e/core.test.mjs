// Golden cases against real Chrome state: plan → apply → final state, zero verification mismatches, empty re-plan.
// Every scenario goes through `scenario()` (lib.mjs), which asserts (a) the final Chrome state, (b) no plan/apply
// errors and no verification mismatches, (c) re-rendering the result plans to nothing.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './helpers.mjs';
import { RESEARCH, STANDARD, scenario } from './lib.mjs';
import { block, del, delBlock, insertAfter, lineOf, moveLine, reindent, replaceLine } from '../unit/fixtures.js';
import { deletionCount } from '../../src/core/plan.js';

let h;
before(async () => { h = await launch({ name: 'core' }); });
after(async () => { await h.close(); });
const fresh = async (spec = STANDARD) => h.seed(spec);
const BM = STANDARD.bookmarks;
const bm = (patch) => ({ ...BM, ...patch });
const DEV = (...kids) => ({ folder: 'Dev', children: kids });
const LATER = (...kids) => ({ folder: 'Read later', children: kids });
const GITHUB = ['GitHub', 'github'];
const MDN = ['MDN', 'mdn'];

// ── tabs ───────────────────────────────────────────────────────────────────
test('E-baseline: no edit applies nothing and changes nothing', async () => {
  const st = await fresh();
  const { plan } = await scenario(h, { edit: (t) => t, expected: st });
  assert.deepEqual(plan.actions, []);
});

test('reorder: a tab to a HIGHER index inside its window', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('neovim'), K('hn'), 2),
    expected: { windows: [['oil', RESEARCH('attention', 'gpt3'), 'hn', 'neovim'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('reorder: a tab to a LOWER index (first position)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('hn'), K.win(1), 2),
    expected: { windows: [['hn', 'neovim', 'oil', RESEARCH('attention', 'gpt3')], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('G4: swap two tabs → reorder, no move', async () => {
  await fresh();
  const r = await scenario(h, {
    edit: (t, K) => moveLine(t, K('codemirror'), K.win(2), 2),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], ['codemirror', 'tmux']], bookmarks: BM },
  });
  assert.deepEqual(r.plan.actions.map((a) => a.kind), ['reorder']);
});

test('G3: move a tab to another window (after the last tab)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('oil'), K('codemirror'), 2),
    expected: { windows: [['neovim', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror', 'oil']], bookmarks: BM },
  });
});

test('cross-window move to the FIRST position of the other window', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('hn'), K.win(2), 2),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3')], ['hn', 'tmux', 'codemirror']], bookmarks: BM },
  });
});

test('G2: close a tab', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => del(t, K('hn')),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3')], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('closing every tab of a window closes the window', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => delBlock(t, K.win(2)),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn']], bookmarks: BM },
  });
});

test('G5: copy a tab line into another window → new tab, original untouched', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(t, K('codemirror'), [lineOf(t, K('oil'))]),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror', 'oil']], bookmarks: BM },
  });
});

test('G6: new tab lines (typed URLs)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(t, K('codemirror'), [`  ${h.url('fresh1')}`, `  Fresh Two ${h.url('fresh2')}`]),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror', 'fresh1', 'fresh2']], bookmarks: BM },
  });
});

test('a new tab line `localhost:<port>` opens http://localhost:<port>/', async () => {
  await fresh();
  const { port } = h.server;
  const r = await scenario(h, {
    edit: (t, K) => insertAfter(t, K('codemirror'), [`  localhost:${port}`]),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror', `http://localhost:${port}/`]], bookmarks: BM },
  });
  assert.equal(r.plan.actions[0].url, `http://localhost:${port}`);
});

test('a new tab line `localhost:<port>/path` and `127.0.0.1:<port>/path` open the page over http', async () => {
  await fresh();
  const { port } = h.server;
  const r = await scenario(h, {
    edit: (t, K) => insertAfter(t, K('codemirror'), [`  localhost:${port}/p/lh`, `  127.0.0.1:${port}/p/ip`]),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror', 'lh', 'ip']], bookmarks: BM },
  });
  assert.deepEqual(r.plan.actions.map((a) => a.url), [`http://localhost:${port}/p/lh`, `http://127.0.0.1:${port}/p/ip`]);
});

test('new tab inserted in the MIDDLE of a window lands at that position', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(t, K('neovim'), [`  ${h.url('mid')}`]),
    expected: { windows: [['neovim', 'mid', 'oil', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('G7: new window holding a moved tab and a new tab', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => `${del(t, K('oil'))}\n\nnew/\n  ${lineOf(t, K('oil')).trim()}\n  ${h.url('a')}`,
    expected: { windows: [['neovim', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror'], ['oil', 'a']], bookmarks: BM },
  });
});

test('new window whose first tab is brand new (the old tab moves in behind it)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => `${del(t, K('hn'))}\n\nfresh/\n  ${h.url('b1')}\n  ${lineOf(t, K('hn')).trim()}`,
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3')], ['tmux', 'codemirror'], ['b1', 'hn']], bookmarks: BM },
  });
});

test('G8: indent a group member to window level (leave the group)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => replaceLine(t, K('attention'), `  ${lineOf(t, K('attention')).trim()}`),
    expected: { windows: [['neovim', 'oil', RESEARCH('gpt3'), 'attention', 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('G9: join a group (tab dropped under the group at member indent)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('hn'), K('gpt3'), 4),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3', 'hn')], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('join a group at its FIRST position', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('hn'), K.title('Research'), 4),
    expected: { windows: [['neovim', 'oil', RESEARCH('hn', 'attention', 'gpt3')], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('join a group in the MIDDLE', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('oil'), K('attention'), 4),
    expected: { windows: [['neovim', RESEARCH('attention', 'oil', 'gpt3'), 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('G10: new group around a tab', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(del(t, K('hn')), K('gpt3'), ['  Later [green]/', `    ${lineOf(t, K('hn')).trim()}`]),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3'), { group: 'Later', color: 'green', tabs: ['hn'] }], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('new group collecting tabs from two windows', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => {
      const noTabs = del(del(t, K('hn')), K('codemirror'));
      return noTabs.replace(`\n\n/w`, `\n  Mix [pink]/\n    ${lineOf(t, K('hn')).trim()}\n    ${lineOf(t, K('codemirror')).trim()}\n\n/w`);
    },
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3'), { group: 'Mix', color: 'pink', tabs: ['hn', 'codemirror'] }], ['tmux']], bookmarks: BM },
  });
});

test('G11: edit a group title and color', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => replaceLine(t, K.title('Research'), `  /${K.title('Research')} Papers [red]/`),
    expected: { windows: [['neovim', 'oil', { group: 'Papers', color: 'red', tabs: ['attention', 'gpt3'] }, 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('a group line written without its `/` renames the group and keeps its color', async () => {
  await fresh();
  const r = await scenario(h, {
    edit: (t, K) => replaceLine(t, K.title('Research'), `  /${K.title('Research')} Reading`),
    expected: { windows: [['neovim', 'oil', { group: 'Reading', color: 'blue', tabs: ['attention', 'gpt3'] }, 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
  assert.deepEqual(r.plan.actions.map((a) => a.kind), ['edit-group']);
});

test('a group line without its `/` but with a ` [color]` suffix sets both title and color', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => replaceLine(t, K.title('Research'), `  /${K.title('Research')} Papers [red]`),
    expected: { windows: [['neovim', 'oil', { group: 'Papers', color: 'red', tabs: ['attention', 'gpt3'] }, 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('a group line cleared by cc empties the title; the members stay in the group', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => replaceLine(t, K.title('Research'), `  /${K.title('Research')} `),
    expected: { windows: [['neovim', 'oil', { group: '', color: 'blue', tabs: ['attention', 'gpt3'] }, 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('a stale group anchor without its `/` is no group line: the write is refused as for an anchorless line', async () => {
  const st = await fresh();
  const r = await scenario(h, {
    edit: (t, K) => insertAfter(t, K('codemirror'), ['  /g99999 Papers', `    ${h.url('member')}`]),
    expected: st,
    allowErrors: true,
  });
  assert.equal(r.report.refused, true);
  assert.match(r.plan.errors[0].message, /cannot read a URL/);
  assert.ok(r.plan.warnings.some((w) => /unknown anchor \/g99999/.test(w.message)));
});

test('G12: delete the group line only → members ungrouped in place', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => del(t, K.title('Research')),
    expected: { windows: [['neovim', 'oil', 'attention', 'gpt3', 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('move a group line with its members to another window', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(delBlock(t, K.title('Research')), K('codemirror'), block(t, K.title('Research'))),
    expected: { windows: [['neovim', 'oil', 'hn'], ['tmux', 'codemirror', RESEARCH('attention', 'gpt3')]], bookmarks: BM },
  });
});

test('move a group to the top of its own window (higher → lower index)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(delBlock(t, K.title('Research')), K.win(1), block(t, K.title('Research'))),
    expected: { windows: [[RESEARCH('attention', 'gpt3'), 'neovim', 'oil', 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('move a group to the end of its own window (lower → higher index)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(delBlock(t, K.title('Research')), K('hn'), block(t, K.title('Research'))),
    expected: { windows: [['neovim', 'oil', 'hn', RESEARCH('attention', 'gpt3')], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('reorder members inside a group', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('gpt3'), K.title('Research'), 4),
    expected: { windows: [['neovim', 'oil', RESEARCH('gpt3', 'attention'), 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('group member dragged to another window (group dissolves around it)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('attention'), K('codemirror'), 2),
    expected: { windows: [['neovim', 'oil', RESEARCH('gpt3'), 'hn'], ['tmux', 'codemirror', 'attention']], bookmarks: BM },
  });
});

test('both group members dragged out: the group line is an empty group (warning), members land elsewhere', async () => {
  await fresh();
  const { plan } = await scenario(h, {
    edit: (t, K) => {
      let x = del(del(t, K('attention')), K('gpt3'));
      x = insertAfter(x, K('codemirror'), [`  ${lineOf(t, K('attention')).trim()}`, `  ${lineOf(t, K('gpt3')).trim()}`]);
      return x;
    },
    expected: { windows: [['neovim', 'oil', 'hn'], ['tmux', 'codemirror', 'attention', 'gpt3']], bookmarks: BM },
  });
  assert.ok(plan.warnings.some((w) => /empty group/.test(w.message)));
});

test('G13: navigate a tab by editing its URL', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => replaceLine(t, K('oil'), `  /${K('oil')} Oil ${h.url('oil2')}`),
    expected: { windows: [['neovim', 'oil2', RESEARCH('attention', 'gpt3'), 'hn'], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('G14: editing a tab title does nothing but warn', async () => {
  const st = await fresh();
  await scenario(h, {
    edit: (t, K) => replaceLine(t, K('oil'), `  /${K('oil')} renamed ${h.url('oil')}`),
    expected: st,
    warnings: ['title is read-only'],
  });
});

test('refuses to apply when the plan has errors (nothing changes)', async () => {
  const st = await fresh();
  const { text, snapshot } = await h.render();
  const { plan, report } = await h.applyText(snapshot, `${text}\n\nhttps://top-level.test/`);
  assert.equal(plan.errors.length, 1);
  assert.equal(report.refused, true);
  assert.deepEqual(await h.settledState(), st);
});

test('pinned tabs: moving one behind an unpinned tab only warns, order is kept', async () => {
  const st = await fresh({ windows: [[{ pin: 'neovim' }, 'oil', 'hn']], bookmarks: {} });
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('neovim'), K('oil'), 2),
    expected: st,
    warnings: ['pinned tabs stay first'],
  });
});

test('pinned tab moved to another window stays pinned and first', async () => {
  await fresh({ windows: [[{ pin: 'neovim' }, 'oil'], ['tmux', 'codemirror']], bookmarks: {} });
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('neovim'), K('tmux'), 2),
    expected: { windows: [['oil'], ['*neovim', 'tmux', 'codemirror']], bookmarks: { bar: [], other: [] } },
  });
});

// ── bookmarks ──────────────────────────────────────────────────────────────
test('G15a: delete a bookmark', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => del(t, K('mdn')),
    expected: { windows: STANDARD.windows.map((w) => w), bookmarks: bm({ bar: [DEV(GITHUB), LATER()] }) },
  }).catch((e) => { throw e; });
});

test('G15b: delete a folder block (removeTree)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => delBlock(t, K.title('Dev')),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [LATER()] }) },
  });
});

test('G16: delete the folder line only → children move up, folder removed', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => del(t, K.title('Dev')),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [GITHUB, MDN, LATER()] }) },
  });
});

test('the deletion count of a nested delete is what Chrome actually removed', async () => {
  const MID = { folder: 'Mid', children: [{ folder: 'Sub', children: [['X', 'x'], ['Y', 'y']] }] };
  await fresh({ windows: STANDARD.windows, bookmarks: bm({ bar: [DEV(GITHUB, MDN, MID), LATER()] }) });
  // the Dev line goes (GitHub, MDN and Mid move up to the bar) and the Sub block (Sub, X, Y) goes with it
  const r = await scenario(h, {
    edit: (t, K) => delBlock(del(t, K.title('Dev')), K.title('Sub')),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [GITHUB, MDN, { folder: 'Mid', children: [] }, LATER()] }) },
  });
  const nodes = (snap) => { let n = 0; const walk = (x) => { n++; (x.children || []).forEach(walk); }; snap.bookmarks.forEach((r) => (r.children || []).forEach(walk)); return n; };
  assert.equal(nodes(r.before.snapshot) - nodes(r.after.snapshot), 4); // Dev, Sub, X, Y
  assert.equal(deletionCount(r.plan.actions), 4);
});

test('G17: rename a bookmark', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => replaceLine(t, K('github'), `    /${K('github')} GitHub! ${h.url('github')}`),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [DEV(['GitHub!', 'github'], MDN), LATER()] }) },
  });
});

test('rename a folder and change a bookmark URL', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => replaceLine(replaceLine(t, K.title('Read later'), `  /${K.title('Read later')} Later/`), K('mdn'), `    /${K('mdn')} MDN ${h.url('mdn2')}`),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [DEV(GITHUB, ['MDN', 'mdn2']), { folder: 'Later', children: [] }] }) },
  });
});

test('a bookmark folder line written without its `/` renames the folder; its children stay in it', async () => {
  await fresh();
  const r = await scenario(h, {
    edit: (t, K) => replaceLine(t, K.title('Dev'), `  /${K.title('Dev')} Tools`),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [{ folder: 'Tools', children: [GITHUB, MDN] }, LATER()] }) },
  });
  assert.deepEqual(r.plan.actions.map((a) => a.kind), ['edit-folder']);
});

test('a bookmark folder line cleared by cc renames the folder to an empty title; its children stay in it', async () => {
  await fresh();
  const r = await scenario(h, {
    edit: (t, K) => replaceLine(t, K.title('Dev'), `  /${K.title('Dev')} `),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [{ folder: '', children: [GITHUB, MDN] }, LATER()] }) },
  });
  assert.deepEqual(r.plan.actions.map((a) => a.kind), ['edit-folder']);
});

test('G18: move a bookmark to another folder', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('wikipedia'), K.title('Read later'), 4),
    expected: { windows: STANDARD.windows, bookmarks: bm({ other: [], bar: [DEV(GITHUB, MDN), LATER(['Wikipedia', 'wikipedia'])] }) },
  });
});

test('reorder inside one folder to a HIGHER index (the bookmarks.move off-by-one case)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('github'), K('mdn'), 4),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [DEV(MDN, GITHUB), LATER()] }) },
  });
});

test('reorder folders in the bar (higher index)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(delBlock(t, K.title('Dev')), K.title('Read later'), block(t, K.title('Dev'))),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [LATER(), DEV(GITHUB, MDN)] }) },
  });
});

test('a bookmark moved into a folder at a given position among existing children', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('wikipedia'), K('github'), 4),
    expected: { windows: STANDARD.windows, bookmarks: bm({ other: [], bar: [DEV(GITHUB, ['Wikipedia', 'wikipedia'], MDN), LATER()] }) },
  });
});

test('new bookmark and new folder with children', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(t, K.title('Read later'), [
      `    Fresh ${h.url('fresh')}`,
      '    Reading/',
      `      Book ${h.url('book')}`,
      `      Paper ${h.url('paper')}`,
    ]),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [DEV(GITHUB, MDN), LATER(['Fresh', 'fresh'], { folder: 'Reading', children: [['Book', 'book'], ['Paper', 'paper']] })] }) },
  });
});

test('G19: move a tab under a bookmark folder → bookmark created, tab closed', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('hn'), K.title('Read later'), 4),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3')], ['tmux', 'codemirror']], bookmarks: bm({ bar: [DEV(GITHUB, MDN), LATER(['Hn', 'hn'])] }) },
  });
});

test('G20: copy a tab under a bookmark folder → bookmark only, tab stays', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(t, K.title('Read later'), [`    ${lineOf(t, K('oil')).trim()}`]),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [DEV(GITHUB, MDN), LATER(['Oil', 'oil'])] }) },
  });
});

test('G21: move a bookmark under a window → tab opened, bookmark deleted', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('github'), K('codemirror'), 2),
    expected: { windows: [STANDARD.windows[0], ['tmux', 'codemirror', 'github']], bookmarks: bm({ bar: [DEV(MDN), LATER()] }) },
  });
});

test('copy a bookmark under a window → tab opened, bookmark stays', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(t, K('codemirror'), [`  ${lineOf(t, K('github')).trim()}`]),
    expected: { windows: [STANDARD.windows[0], ['tmux', 'codemirror', 'github']], bookmarks: BM },
  });
});

test('G22: copy a folder block to the top level → new window, original folder kept', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => `${t}\n\n${block(t, K.title('Dev')).map((l) => l.slice(2)).join('\n')}`,
    expected: { windows: [...STANDARD.windows, ['github', 'mdn']], bookmarks: BM },
  });
});

test('G22b: move a folder block to the top level → new window, folder deleted', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => `${delBlock(t, K.title('Dev'))}\n\n${block(t, K.title('Dev')).map((l) => l.slice(2)).join('\n')}`,
    expected: { windows: [...STANDARD.windows, ['github', 'mdn']], bookmarks: bm({ bar: [LATER()] }) },
  });
});

test('G23: copy a window block under the bookmark bar → new folder with bookmarks, window kept', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(t, K.title('Read later'), reindent(block(t, K.win(2)), 2)),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [DEV(GITHUB, MDN), LATER(), { folder: 'Window 2', children: [['Tmux', 'tmux'], ['Codemirror', 'codemirror']] }] }) },
  });
});

test('G23b: move a window block under the bookmark bar → window closed, folder created', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(delBlock(t, K.win(2)), K.title('Read later'), reindent(block(t, K.win(2)), 2)),
    expected: { windows: [STANDARD.windows[0]], bookmarks: bm({ bar: [DEV(GITHUB, MDN), LATER(), { folder: 'Window 2', children: [['Tmux', 'tmux'], ['Codemirror', 'codemirror']] }] }) },
  });
});

test('copy a group block under a bookmark folder → new folder titled without the [color], bookmarks from its tabs, group kept', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(t, K.title('Read later'), reindent(block(t, K.title('Research')), 2)),
    expected: {
      windows: STANDARD.windows,
      bookmarks: bm({ bar: [DEV(GITHUB, MDN), LATER({ folder: 'Research', children: [['Attention', 'attention'], ['Gpt3', 'gpt3']] })] }),
    },
  });
});

test('a bookmark folder dropped into another folder (move-folder)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => insertAfter(delBlock(t, K.title('Read later')), K('mdn'), ['    /' + K.title('Read later') + ' Read later/']),
    expected: { windows: STANDARD.windows, bookmarks: bm({ bar: [DEV(GITHUB, MDN, LATER())] }) },
  });
});

// ── combined / external ────────────────────────────────────────────────────
test('kitchen sink: dd, p, >> style edits in one write', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => {
      let x = del(t, K('hn')); // close hn
      x = moveLine(x, K('oil'), K('codemirror'), 2); // oil → window 2
      x = moveLine(x, K('neovim'), K('gpt3'), 4); // neovim joins Research
      x = replaceLine(x, K('github'), `    /${K('github')} GitHub!! ${h.url('github')}`);
      x = insertAfter(x, K.title('Read later'), [`    ${h.url('later1')}`]);
      return x;
    },
    expected: {
      windows: [[RESEARCH('attention', 'gpt3', 'neovim')], ['tmux', 'codemirror', 'oil']],
      bookmarks: bm({ bar: [DEV(['GitHub!!', 'github'], MDN), LATER(['', 'later1'])] }),
    },
  });
});

test('external change between render and :w: gone entities are skipped, F-only tabs are never closed', async () => {
  await fresh();
  const { text, snapshot } = await h.render();
  const K = (await import('./lib.mjs')).keysOf(text);
  // outside: close codemirror, open a brand-new tab in window 2
  await h.call(async ({ url }) => {
    const wins = (await chrome.windows.getAll({ populate: true })).filter((w) => w.type === 'normal').sort((a, b) => a.id - b.id);
    const w2 = wins[1];
    const cm = w2.tabs.find((t) => t.url.endsWith('/p/codemirror'));
    await chrome.tabs.remove(cm.id);
    await chrome.tabs.create({ windowId: w2.id, url, active: false });
  }, { url: h.url('outside') });
  const { plan, report } = await h.applyText(snapshot, del(text, K('hn')));
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(report.errors, []);
  assert.ok(plan.warnings.some((w) => w.message === 'gone — skipped'));
  const st = await h.settledState();
  assert.deepEqual(st.windows, [['neovim', 'oil', RESEARCH('attention', 'gpt3')], ['tmux', 'outside']]);
});

test('deletions are journaled in chrome.storage.local before they happen (folder subtree + closed tab)', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => del(delBlock(t, K.title('Dev')), K('hn')),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3')], ['tmux', 'codemirror']], bookmarks: bm({ bar: [LATER()] }) },
  });
  const journal = await h.call(async () => (await chrome.storage.local.get('journal')).journal);
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0].tabs.map((t) => t.title), ['Hn']);
  const dev = journal[0].bookmarks[0];
  assert.equal(dev.title, 'Dev');
  assert.deepEqual(dev.children.map((c) => [c.title, c.url.split('/').pop()]), [['GitHub', 'github'], ['MDN', 'mdn']]);
});

test('a group whose members all leave but is refilled by other tabs is recreated with its title and color', async () => {
  await fresh();
  await scenario(h, {
    edit: (t, K) => {
      // Research keeps its line but loses attention/gpt3 (they stay in the window, ungrouped) and takes oil + hn instead
      let x = del(del(del(del(t, K('attention')), K('gpt3')), K('oil')), K('hn'));
      x = insertAfter(x, K.title('Research'), [`    ${lineOf(t, K('oil')).trim()}`, `    ${lineOf(t, K('hn')).trim()}`]);
      return insertAfter(x, K.win(1), [`  ${lineOf(t, K('attention')).trim()}`, `  ${lineOf(t, K('gpt3')).trim()}`]);
    },
    expected: { windows: [['attention', 'gpt3', 'neovim', RESEARCH('oil', 'hn')], ['tmux', 'codemirror']], bookmarks: BM },
  });
});

test('collapsed groups behave like open ones: join, move to another window', async () => {
  const collapse = () => h.call(async () => { const g = (await chrome.tabGroups.query({}))[0]; await chrome.tabGroups.update(g.id, { collapsed: true }); });
  await fresh();
  await collapse();
  await scenario(h, {
    edit: (t, K) => moveLine(t, K('hn'), K('gpt3'), 4),
    expected: { windows: [['neovim', 'oil', RESEARCH('attention', 'gpt3', 'hn')], ['tmux', 'codemirror']], bookmarks: BM },
  });
  await fresh();
  await collapse();
  await scenario(h, {
    edit: (t, K) => insertAfter(delBlock(t, K.title('Research')), K('codemirror'), block(t, K.title('Research'))),
    expected: { windows: [['neovim', 'oil', 'hn'], ['tmux', 'codemirror', RESEARCH('attention', 'gpt3')]], bookmarks: BM },
  });
});
