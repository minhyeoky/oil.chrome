// apply() safety rules, checked against a recording fake of the chrome API (the real thing is in test/e2e).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../../src/core/apply.js';
import { plan } from '../../src/core/plan.js';
import { S, EXAMPLE, delBlock, moveLine, del } from './fixtures.js';

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
