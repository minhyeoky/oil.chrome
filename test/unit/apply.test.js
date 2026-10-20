// apply() safety rules, checked against a recording fake of the chrome API (the real thing is in test/e2e).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../../src/core/apply.js';
import { plan } from '../../src/core/plan.js';
import { render } from '../../src/core/render.js';
import { S, EXAMPLE, block, del, delBlock, insertAfter, lineOf, moveLine, replaceLine } from './fixtures.js';

/** A fake `chrome` namespace: every method resolves quietly; `failOn` makes named methods throw. */
function fakeApi({ failOn = [] } = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => {
    calls.push(name);
    if (failOn.includes(name)) throw new Error(`${name} failed`);
    return typeof result === 'function' ? result(...args) : result;
  };
  const store = {};
  return {
    calls,
    store,
    windows: { create: rec('windows.create', () => ({ id: 900, tabs: [{ id: 901 }] })), remove: rec('windows.remove') },
    tabs: {
      create: rec('tabs.create', () => ({ id: 902 })), query: rec('tabs.query', []), get: rec('tabs.get', () => ({ windowId: 1, groupId: -1 })),
      move: rec('tabs.move'), group: rec('tabs.group', 903), ungroup: rec('tabs.ungroup'), update: rec('tabs.update'), remove: rec('tabs.remove'),
    },
    tabGroups: { get: rec('tabGroups.get', () => { throw new Error('no group'); }), move: rec('tabGroups.move'), update: rec('tabGroups.update') },
    bookmarks: {
      create: rec('bookmarks.create', () => ({ id: '777' })), getChildren: rec('bookmarks.getChildren', []), move: rec('bookmarks.move'),
      update: rec('bookmarks.update'), remove: rec('bookmarks.remove'), removeTree: rec('bookmarks.removeTree'),
      getSubTree: rec('bookmarks.getSubTree', (id) => [{ id, title: `tree ${id}`, children: [] }]),
    },
    storage: {
      local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (o) => { Object.assign(store, o); },
      },
    },
  };
}

const planFor = (text) => plan(S, S, text);
const DESTRUCTIVE = ['tabs.remove', 'bookmarks.remove', 'bookmarks.removeTree'];

test('moving a tab into a bookmark folder: when the bookmark cannot be created, the tab is NOT closed', async () => {
  const p = planFor(moveLine(EXAMPLE, 't15', 'b13', 4)); // new-bookmark + close-tab
  assert.deepEqual(p.actions.map((a) => a.kind), ['new-bookmark', 'close-tab']);
  const api = fakeApi({ failOn: ['bookmarks.create'] });
  const report = await apply(api, p);
  assert.equal(report.skippedDeletes, true);
  assert.ok(report.errors.some((e) => /bookmarks\.create failed/.test(e.message)));
  for (const d of DESTRUCTIVE) assert.ok(!api.calls.includes(d), `${d} must not run after a failure`);
});

test('without errors, deletions run after everything else and are journaled first', async () => {
  const p = planFor(del(EXAMPLE, 't15'));
  const api = fakeApi();
  const report = await apply(api, p);
  assert.equal(report.skippedDeletes, false);
  assert.ok(api.calls.includes('tabs.remove'));
  assert.equal(api.store.journal.length, 1);
  assert.deepEqual(api.store.journal[0].tabs, [{ url: 'https://news.ycombinator.com/', title: 'Hacker News' }]);
});

test('deleting a bookmark folder journals its whole subtree before removeTree', async () => {
  const p = planFor(delBlock(EXAMPLE, 'b10'));
  const api = fakeApi();
  await apply(api, p);
  const idx = (n) => api.calls.indexOf(n);
  assert.ok(idx('bookmarks.getSubTree') >= 0 && idx('bookmarks.getSubTree') < idx('bookmarks.removeTree'));
  assert.equal(api.store.journal[0].bookmarks[0].id, '10');
});

test('the journal keeps the last 20 deletions', async () => {
  const api = fakeApi();
  for (let i = 0; i < 25; i++) await apply(api, planFor(del(EXAMPLE, 't15')));
  assert.equal(api.store.journal.length, 20);
});

test('a plan with errors is refused without touching Chrome', async () => {
  const p = planFor(`${EXAMPLE}\n\nhttps://x.test/`);
  const api = fakeApi();
  const report = await apply(api, p);
  assert.equal(report.refused, true);
  assert.deepEqual(api.calls, []);
});

test('a failed journal write also skips the deletions', async () => {
  const api = fakeApi();
  api.storage.local.set = async () => { throw new Error('quota'); };
  const report = await apply(api, planFor(del(EXAMPLE, 't15')));
  assert.equal(report.skippedDeletes, true);
  assert.ok(!api.calls.includes('tabs.remove'));
});

test('a folder that gained a bookmark after the plan is not removed (removeTree would take it along)', async () => {
  const p = planFor(delBlock(EXAMPLE, 'b10'));
  const api = fakeApi();
  api.bookmarks.getSubTree = async (id) => [{ id, title: 'Dev', children: [{ id: '11', title: 'GitHub', url: 'https://github.com/' }, { id: '999', title: 'Added meanwhile', url: 'https://late.test/' }] }];
  const report = await apply(api, p);
  assert.equal(report.skippedDeletes, true);
  assert.ok(report.errors.some((e) => /added outside \(Added meanwhile\)/.test(e.message)));
  assert.ok(!api.calls.includes('bookmarks.removeTree'));
  assert.equal(api.store.journal, undefined, 'nothing journaled for a deletion that did not happen');
});

// ── windows, tabs and groups: a stateful stand-in ───────────────────────────────────────────────────────────────
// fakeApi() above answers every call quietly, which cannot show what a window or a group looks like after tabs left it.

/**
 * Bookmarks and storage stay fakeApi's. The rest follows what test/e2e/chrome-behavior.test.mjs observed in Chromium:
 * a window closes with its last tab and a group ends with its last member; unpinned tabs stay behind the pinned ones;
 * a tab moved inside a group's span joins it (a member stays in its own), across windows it drops group and pin;
 * tabs.group pulls a tab next to its group and rejects an unknown id as a whole; ungrouping a middle member puts it
 * behind the group. Only the calls the tests below make are modelled (no new groups or windows from a URL, no pinning).
 * `raw` is a snapshot in the shape model.js documents.
 */
function modelApi(raw, { failOn = [] } = {}) {
  const api = fakeApi({ failOn });
  const wins = new Map(); // window id → tab ids in index order
  const tabs = new Map(); // tab id → { id, url, title, pinned, groupId, windowId }
  for (const w of raw.windows) {
    wins.set(w.id, w.tabs.map((t) => t.id));
    for (const t of w.tabs) tabs.set(t.id, { id: t.id, url: t.url, title: t.title, pinned: t.pinned, groupId: t.groupId, windowId: w.id });
  }
  let nextId = 900;
  const created = [];
  const removed = [];
  const m = (name, fn) => async (...args) => {
    api.calls.push(name);
    if (failOn.includes(name)) throw new Error(`${name} failed`);
    return fn(...args);
  };
  const tabOf = (id) => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`); return tabs.get(id); };
  const listOf = (wid) => { if (!wins.has(wid)) throw new Error(`No window with id: ${wid}.`); return wins.get(wid); };
  const view = (t) => ({ id: t.id, windowId: t.windowId, index: wins.get(t.windowId).indexOf(t.id), url: t.url, title: t.title, pinned: t.pinned, groupId: t.groupId });
  const span = (gid) => {
    const ms = gid < 0 ? [] : [...tabs.values()].filter((t) => t.groupId === gid);
    if (!ms.length) return null;
    const at = ms.map((t) => wins.get(t.windowId).indexOf(t.id));
    return { wid: ms[0].windowId, start: Math.min(...at), end: Math.max(...at) };
  };
  const lift = (t) => { // out of its window, which closes with its last tab
    const l = wins.get(t.windowId);
    l.splice(l.indexOf(t.id), 1);
    if (!l.length) wins.delete(t.windowId);
  };
  const put = (t, wid, index) => { // into a window; unpinned tabs stay behind the pinned ones
    const l = listOf(wid);
    const pinned = l.filter((id) => tabs.get(id).pinned).length;
    const at = t.pinned ? Math.min(index < 0 ? pinned : index, pinned) : Math.max(index < 0 ? l.length : Math.min(index, l.length), pinned);
    l.splice(at, 0, t.id);
    t.windowId = wid;
    return at;
  };

  api.windows.create = m('windows.create', ({ tabId }) => {
    const t = tabOf(tabId);
    lift(t);
    t.pinned = false;
    t.groupId = -1;
    const wid = nextId++;
    wins.set(wid, [t.id]);
    t.windowId = wid;
    return { id: wid, tabs: [view(t)] };
  });
  api.tabs = {
    create: m('tabs.create', ({ windowId, url, active }) => {
      const l = listOf(windowId);
      const t = { id: nextId++, url, title: url, pinned: false, groupId: -1, windowId };
      tabs.set(t.id, t);
      l.push(t.id);
      created.push({ windowId, url, active });
      return view(t);
    }),
    get: m('tabs.get', (id) => view(tabOf(id))),
    query: m('tabs.query', ({ windowId } = {}) => [...wins].filter(([wid]) => windowId === undefined || wid === windowId).flatMap(([, l]) => l.map((id) => view(tabs.get(id))))),
    update: m('tabs.update', (id, { url }) => { tabOf(id).url = url; }),
    move: m('tabs.move', (id, { windowId, index }) => {
      const t = tabOf(id);
      const across = windowId !== undefined && windowId !== t.windowId;
      const own = span(t.groupId);
      listOf(across ? windowId : t.windowId);
      lift(t);
      if (across) { t.groupId = -1; t.pinned = false; }
      const at = put(t, across ? windowId : t.windowId, index);
      if (!across && own && at >= own.start && at <= own.end) return view(t); // inside its own group's span it stays
      const l = wins.get(t.windowId);
      const [left, right] = [tabs.get(l[at - 1]), tabs.get(l[at + 1])];
      t.groupId = left && right && left.groupId !== -1 && left.groupId === right.groupId ? left.groupId : -1;
      return view(t);
    }),
    group: m('tabs.group', ({ tabIds, groupId }) => {
      const ts = [].concat(tabIds).map(tabOf);
      if (!span(groupId)) throw new Error(`No group with id: ${groupId}.`);
      for (const t of ts) {
        const was = span(groupId);
        const fromLeft = t.windowId === was.wid && wins.get(was.wid).indexOf(t.id) < was.start;
        lift(t);
        t.pinned = false;
        const now = span(groupId);
        put(t, was.wid, fromLeft ? now.start : now.end + 1);
        t.groupId = groupId;
      }
      return groupId;
    }),
    ungroup: m('tabs.ungroup', (ids) => {
      for (const t of [].concat(ids).map(tabOf)) {
        const sp = span(t.groupId);
        if (!sp) continue;
        const l = wins.get(t.windowId);
        const i = l.indexOf(t.id);
        t.groupId = -1;
        if (i !== sp.start && i !== sp.end) { l.splice(i, 1); l.splice(sp.end, 0, t.id); }
      }
    }),
    remove: m('tabs.remove', (ids) => {
      for (const t of [].concat(ids).map(tabOf)) { removed.push({ id: t.id, url: t.url, groupId: t.groupId }); lift(t); tabs.delete(t.id); }
    }),
  };
  api.tabGroups = {
    get: m('tabGroups.get', (gid) => {
      const sp = span(gid);
      if (!sp) throw new Error(`No group with id: ${gid}.`);
      return { id: gid, windowId: sp.wid };
    }),
    move: m('tabGroups.move', (gid, { windowId, index }) => {
      const sp = span(gid);
      if (!sp) throw new Error(`No group with id: ${gid}.`);
      const wid = windowId ?? sp.wid;
      listOf(wid);
      const ms = wins.get(sp.wid).slice(sp.start, sp.end + 1).map((id) => tabs.get(id));
      for (const t of ms) { lift(t); t.pinned = false; }
      const at = index < 0 ? wins.get(wid).length : index;
      ms.forEach((t, k) => put(t, wid, at + k));
    }),
  };
  return Object.assign(api, {
    created, // every tab the code under test opened with tabs.create: { windowId, url, active }
    removed, // every tab it closed, with the group it was in at that moment
    groupOf: (id) => tabs.get(id)?.groupId,
    /** per window (by id), the tabs in order: title, `*` pinned, `(g<id>)` grouped */
    layout: () => [...wins].sort(([a], [b]) => a - b).map(([, l]) => l.map((id) => {
      const t = tabs.get(id);
      return `${t.pinned ? '*' : ''}${t.title}${t.groupId < 0 ? '' : `(g${t.groupId})`}`;
    })),
  });
}

const tab = (id, title, extra = {}) => ({ id, title, url: `https://${title.toLowerCase()}.test/`, pinned: false, active: false, groupId: -1, ...extra });
const world = (windows, groups = []) => ({
  windows: windows.map((tabs, i) => ({ id: i + 1, focused: false, tabs: tabs.map((t, j) => ({ ...t, index: j })) })),
  groups,
  bookmarks: [],
});
const G5 = [{ id: 5, windowId: 1, title: 'G', color: 'blue' }];
const placeholders = (api) => api.created.filter((c) => c.url === 'about:blank');
const swapTabs = (text, a, wa, b, wb) => moveLine(moveLine(text, a, wb, 2), b, wa, 2); // a ↔ b, between windows wa and wb

// ── a window that an earlier step empties must outlive it ────────────────────────────────────────────────────────
test('swapping the tab lines of two one-tab windows: a placeholder tab keeps each window open until its new tab arrived', async () => {
  const s = world([[tab(11, 'A')], [tab(21, 'B')]]);
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, swapTabs(render(s).text, 't11', 'w1', 't21', 'w2')));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['B'], ['A']]);
  assert.deepEqual(placeholders(api), [{ windowId: 1, url: 'about:blank', active: false }, { windowId: 2, url: 'about:blank', active: false }]);
  assert.equal(report.applied, 2, 'the placeholders are not counted');
});

test('a one-tab window hands its tab to a new window and takes a new tab in the same write', async () => {
  const s = world([[tab(11, 'A')]]);
  const text = render(s).text;
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, `${replaceLine(text, 't11', '  https://x.test/')}\n\nmoved/\n${lineOf(text, 't11')}`));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['https://x.test/'], ['A']]);
});

test('a window whose only tabs are a group sends the group away and is refilled from the other window', async () => {
  const s = world([[tab(11, 'A', { groupId: 5 }), tab(12, 'B', { groupId: 5 })], [tab(21, 'X'), tab(22, 'Y')]], G5);
  const text = render(s).text;
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, moveLine(insertAfter(delBlock(text, 'g5'), 't22', block(text, 'g5')), 't21', 'w1', 2)));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['X'], ['Y', 'A(g5)', 'B(g5)']]);
  assert.deepEqual(placeholders(api).map((c) => c.windowId), [1]);
  assert.deepEqual(api.removed.filter((r) => r.url === 'about:blank').map((r) => r.groupId), [-1], 'the placeholder never joined the group');
});

test('a tab the plan closes later rides out with its group, so the window it leaves still needs a placeholder', async () => {
  const s = world([[tab(11, 'A')], [tab(21, 'X', { groupId: 5 }), tab(22, 'Y', { groupId: 5 })]], [{ id: 5, windowId: 2, title: 'G', color: 'blue' }]);
  const text = render(s).text;
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, moveLine(del(insertAfter(delBlock(text, 'g5'), 'w1', block(text, 'g5')), 't22'), 't11', 'w2', 2)));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['X(g5)'], ['A']]);
  assert.deepEqual(placeholders(api).map((c) => c.windowId), [1, 2]);
});

test('a tab that stays in its window still rides out with its group, so the window needs a placeholder', async () => {
  const s = world([[tab(11, 'X', { groupId: 5 }), tab(12, 'Y', { groupId: 5 })], [tab(21, 'B')]], [{ id: 5, windowId: 1, title: 'G', color: 'blue' }]);
  const t = render(s).text;
  // the group line moves to window 2 with Y; X is dedented and stays in window 1
  const edited = ['/w1 Window 1/', `  ${lineOf(t, 't11').trim()}`, '', '/w2 Window 2/', lineOf(t, 't21'), lineOf(t, 'g5'), lineOf(t, 't12')].join('\n');
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, edited));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['X'], ['B', 'Y(g5)']]);
  assert.deepEqual(placeholders(api).map((c) => c.windowId), [1]);
});

test('no placeholder for a window that keeps a tab the plan closes later', async () => {
  const s = world([[tab(11, 'A'), tab(12, 'X')], [tab(21, 'B')]]);
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, del(swapTabs(render(s).text, 't11', 'w1', 't21', 'w2'), 't12')));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['B'], ['A']]);
  assert.deepEqual(placeholders(api).map((c) => c.windowId), [2], 'window 1 holds X until the delete phase');
});

test('no placeholder for a window that keeps a tab opened outside while editing', async () => {
  const s = world([[tab(11, 'A')], [tab(21, 'B')]]);
  const f = world([[tab(11, 'A'), tab(12, 'U')], [tab(21, 'B')]]);
  const api = modelApi(f);
  const report = await apply(api, plan(s, f, swapTabs(render(s).text, 't11', 'w1', 't21', 'w2')));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['U', 'B'], ['A']]);
  assert.deepEqual(placeholders(api).map((c) => c.windowId), [2], 'a tab the plan does not know is never moved');
});

test('no placeholder for a window the buffer empties on purpose', async () => {
  const s = world([[tab(11, 'A')], [tab(21, 'B')]]);
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, moveLine(render(s).text, 't21', 'w1', 2)));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(api.layout(), [['B', 'A']]);
  assert.deepEqual(placeholders(api), []);
});

test('a placeholder that cannot be removed is neither an error nor a mismatch', async () => {
  const s = world([[tab(11, 'A')], [tab(21, 'B')]]);
  const api = modelApi(s, { failOn: ['tabs.remove'] });
  const report = await apply(api, plan(s, s, swapTabs(render(s).text, 't11', 'w1', 't21', 'w2')));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.applied, 2);
  assert.deepEqual(api.layout(), [['about:blank', 'B'], ['about:blank', 'A']]);
});

test('when placement fails the placeholders are still removed and no tab is lost', async () => {
  const s = world([[tab(11, 'A')], [tab(21, 'B')]]);
  const api = modelApi(s, { failOn: ['tabs.move'] });
  const report = await apply(api, plan(s, s, swapTabs(render(s).text, 't11', 'w1', 't21', 'w2')));
  assert.ok(report.errors.length > 0);
  assert.deepEqual(api.layout(), [['A'], ['B']]);
});

// ── pinned tabs the desired state does not place ─────────────────────────────────────────────────────────────────
test('a pinned tab closed in the same write does not push the placement of the unpinned tabs off', async () => {
  const s = world([[tab(11, 'P1', { pinned: true }), tab(12, 'P2', { pinned: true }), tab(13, 'A'), tab(14, 'B'), tab(15, 'C')]]);
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, moveLine(del(render(s).text, 't11'), 't15', 't12', 2)));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['*P2', 'C', 'A', 'B']]);
});

test('a pinned tab opened outside while editing stays in front of the placed tabs', async () => {
  const s = world([[tab(11, 'A'), tab(12, 'B'), tab(13, 'C')]]);
  const f = world([[tab(40, 'U', { pinned: true }), tab(11, 'A'), tab(12, 'B'), tab(13, 'C')]]);
  const api = modelApi(f);
  const report = await apply(api, plan(s, f, moveLine(render(s).text, 't13', 'w1', 2)));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(api.layout(), [['*U', 'C', 'A', 'B']]);
});

// ── tabs ungrouped ahead of closing return when the deletes are skipped ──────────────────────────────────────────
const groupedWindow = () => world([[tab(11, 'A'), tab(12, 'X', { groupId: 5 }), tab(13, 'Y', { groupId: 5 }), tab(14, 'Z', { groupId: 5 })]], G5);
const navigateA = (text) => replaceLine(text, 't11', '  /t11 A https://a2.test/'); // the navigation is what the test makes fail

test('a tab ungrouped ahead of closing rejoins its group when something fails and the deletes are skipped', async () => {
  const s = groupedWindow();
  const api = modelApi(s, { failOn: ['tabs.update'] });
  const report = await apply(api, plan(s, s, del(navigateA(render(s).text), 't13')));
  assert.equal(report.skippedDeletes, true);
  assert.deepEqual(report.errors.map((e) => e.op), ['navigate https://a2.test/']);
  assert.ok(!api.calls.includes('tabs.remove'));
  assert.equal(api.groupOf(13), 5);
  assert.deepEqual(api.layout(), [['A', 'X(g5)', 'Z(g5)', 'Y(g5)']]);
});

test('no tab is put back when the deletes run', async () => {
  const s = groupedWindow();
  const api = modelApi(s);
  const report = await apply(api, plan(s, s, del(render(s).text, 't13')));
  assert.equal(report.skippedDeletes, false);
  assert.deepEqual(report.errors, []);
  assert.equal(api.calls.filter((c) => c === 'tabs.group').length, 0);
  assert.deepEqual(api.layout(), [['A', 'X(g5)', 'Z(g5)']]);
});

test('closing tabs whose group dissolved when they left it stay ungrouped, without an error', async () => {
  const s = world([[tab(11, 'A'), tab(12, 'Y', { groupId: 5 }), tab(13, 'Z', { groupId: 5 })]], G5);
  const api = modelApi(s, { failOn: ['tabs.update'] });
  const report = await apply(api, plan(s, s, delBlock(navigateA(render(s).text), 'g5')));
  assert.equal(report.skippedDeletes, true);
  assert.deepEqual(report.errors.map((e) => e.op), ['navigate https://a2.test/']);
  assert.ok(!api.calls.includes('tabs.group'));
  assert.deepEqual(api.layout(), [['A', 'Y', 'Z']]);
});

test('putting a tab back is recorded as an error when it fails', async () => {
  const s = groupedWindow();
  const api = modelApi(s, { failOn: ['tabs.update', 'tabs.group'] });
  const report = await apply(api, plan(s, s, del(navigateA(render(s).text), 't13')));
  assert.equal(report.skippedDeletes, true);
  assert.ok(report.errors.some((e) => /regroup/.test(e.op) && /tabs\.group failed/.test(e.message)));
  assert.equal(api.groupOf(13), -1);
});

test('a tab that vanished before it could be put back does not fail the others', async () => {
  const s = groupedWindow();
  const api = modelApi(s);
  api.tabs.update = async () => { await api.tabs.remove(13); throw new Error('boom'); }; // Y is closed outside while the navigation fails
  const report = await apply(api, plan(s, s, del(del(navigateA(render(s).text), 't13'), 't14')));
  assert.equal(report.skippedDeletes, true);
  assert.deepEqual(report.errors.map((e) => e.message), ['boom']);
  assert.deepEqual(api.layout(), [['A', 'X(g5)', 'Z(g5)']]);
});

// ── the journal keeps what the tabs are now ──────────────────────────────────────────────────────────────────────
test('the journal stores the live URL and title of a tab that changed since the snapshot; the planned ones when it cannot be read', async () => {
  const s = world([[tab(11, 'A'), tab(12, 'B')]]);
  const f = world([[tab(11, 'A'), tab(12, 'B', { url: 'https://b2.test/', title: 'B2' })]]);
  const p = plan(s, f, del(render(s).text, 't12'));
  assert.deepEqual(p.actions.map((a) => [a.kind, a.url, a.title]), [['close-tab', 'https://b.test/', 'B']]);
  const live = modelApi(f);
  await apply(live, p);
  assert.deepEqual(live.store.journal[0].tabs, [{ url: 'https://b2.test/', title: 'B2' }]);
  const blind = modelApi(f, { failOn: ['tabs.get'] });
  await apply(blind, p);
  assert.deepEqual(blind.store.journal[0].tabs, [{ url: 'https://b.test/', title: 'B' }]);
});
