// Chrome behaviours the design did not state, pinned down as tests. Each assertion is an OBSERVATION made against
// Playwright's bundled Chromium (headless new mode); apply.js is written around them. If a Chrome update changes
// one, the failing test names the assumption that moved.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './helpers.mjs';

// Runs inside the service worker: a tiny toolkit `T` for building windows and printing layouts.
const PRELUDE = `
globalThis.T = {
  base: null,
  names: new Map(),
  async win(n) { const w = await chrome.windows.create({ url: T.base + '/' + n, focused: false }); T.names.set(w.tabs[0].id, n); return w; },
  async tab(wid, n) { const t = await chrome.tabs.create({ windowId: wid, url: T.base + '/' + n, active: false }); T.names.set(t.id, n); return t.id; },
  async wait() { for (let i = 0; i < 100; i++) { if ((await chrome.tabs.query({})).every((t) => t.status === 'complete')) return; await new Promise((r) => setTimeout(r, 30)); } },
  async layout(wid) {
    const tabs = (await chrome.tabs.query({ windowId: wid })).sort((a, b) => a.index - b.index);
    const gids = [...new Set(tabs.filter((t) => t.groupId >= 0).map((t) => t.groupId))];
    return tabs.map((t) => (t.pinned ? '*' : '') + (T.names.get(t.id) || '?') + (t.groupId >= 0 ? '(g' + (gids.indexOf(t.groupId) + 1) + ')' : '')).join(' ');
  },
  async six(prefix) { const w = await T.win(prefix + '0'); const ids = [w.tabs[0].id]; for (let i = 1; i < 6; i++) ids.push(await T.tab(w.id, prefix + i)); await T.wait(); return { wid: w.id, ids }; },
};
`;

let h;
before(async () => { h = await launch({ name: 'behavior' }); });
after(async () => { await h.close(); });
const sw = (fn, arg) => h.call(fn, { base: h.url('x').replace(/\/x$/, ''), ...arg }, { prelude: PRELUDE });
const SETUP = 'T.base = arg.base;';

test('OBSERVED fresh profile: one normal window with about:blank; bookmark roots are only Bookmarks Bar (1) and Other Bookmarks (2)', async () => {
  const r = await h.call(async () => ({
    wins: (await chrome.windows.getAll({ populate: true })).map((w) => ({ type: w.type, urls: w.tabs.map((t) => t.url) })),
    roots: (await chrome.bookmarks.getTree())[0].children.map((c) => ({ id: c.id, title: c.title, folderType: c.folderType })),
  }));
  assert.ok(r.wins.some((w) => w.type === 'normal'));
  assert.deepEqual(r.roots, [
    { id: '1', title: 'Bookmarks Bar', folderType: 'bookmarks-bar' },
    { id: '2', title: 'Other Bookmarks', folderType: 'other' },
  ]);
});

test('OBSERVED tabs.move lands at exactly `index`, including moves to a higher index', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const { wid, ids } = await T.six('a');
    const o = [];
    await chrome.tabs.move(ids[0], { index: 3 });
    o.push(await T.layout(wid));
    await chrome.tabs.move(ids[0], { index: 100 });
    o.push(await T.layout(wid));
    return o;
  });
  assert.deepEqual(out, ['a1 a2 a3 a0 a4 a5', 'a1 a2 a3 a4 a5 a0']);
});

test('OBSERVED tabs.move into a group: joins only when members are on BOTH sides; the group edges do not join', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const { wid, ids } = await T.six('g');
    await chrome.tabs.group({ tabIds: [ids[2], ids[3]], createProperties: { windowId: wid } });
    const o = [await T.layout(wid)];
    await chrome.tabs.move(ids[5], { index: 3 }); // between the two members
    o.push(await T.layout(wid));
    await chrome.tabs.move(ids[5], { index: -1 });
    await chrome.tabs.move(ids[5], { index: 2 }); // the first member's index: lands BEFORE the group
    o.push(await T.layout(wid));
    await chrome.tabs.move(ids[5], { index: -1 });
    await chrome.tabs.move(ids[5], { index: 4 }); // right after the last member
    o.push(await T.layout(wid));
    return o;
  });
  assert.equal(out[0], 'g0 g1 g2(g1) g3(g1) g4 g5');
  assert.equal(out[1], 'g0 g1 g2(g1) g5(g1) g3(g1) g4', 'interior index joins');
  assert.equal(out[2], 'g0 g1 g5 g2(g1) g3(g1) g4', 'first-member index stays outside');
  assert.equal(out[3], 'g0 g1 g2(g1) g3(g1) g5 g4', 'after the last member stays outside');
});

test('OBSERVED tabs.move of a member: inside its group span it stays, outside it leaves the group', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const { wid, ids } = await T.six('m');
    await chrome.tabs.group({ tabIds: [ids[1], ids[2], ids[3]], createProperties: { windowId: wid } });
    const o = [];
    await chrome.tabs.move(ids[3], { index: 1 });
    o.push(await T.layout(wid));
    await chrome.tabs.move(ids[3], { index: 3 });
    o.push(await T.layout(wid));
    await chrome.tabs.move(ids[3], { index: 4 });
    o.push(await T.layout(wid));
    return o;
  });
  assert.deepEqual(out, ['m0 m3(g1) m1(g1) m2(g1) m4 m5', 'm0 m1(g1) m2(g1) m3(g1) m4 m5', 'm0 m1(g1) m2(g1) m4 m3 m5']);
});

test('OBSERVED tabs.move across windows drops group AND pinned state (index clamps behind pinned tabs)', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const a = await T.win('x0'); const x1 = await T.tab(a.id, 'x1'); const x2 = await T.tab(a.id, 'x2');
    const b = await T.win('y0'); const y1 = await T.tab(b.id, 'y1');
    await T.wait();
    await chrome.tabs.group({ tabIds: [x1, x2], createProperties: { windowId: a.id } });
    await chrome.tabs.update(a.tabs[0].id, { pinned: true });
    await chrome.tabs.update(b.tabs[0].id, { pinned: true });
    const o = [await T.layout(a.id), await T.layout(b.id)];
    await chrome.tabs.move(x1, { windowId: b.id, index: -1 });
    o.push(await T.layout(a.id), await T.layout(b.id));
    await chrome.tabs.move(a.tabs[0].id, { windowId: b.id, index: 0 });
    o.push(await T.layout(b.id));
    return o;
  });
  assert.deepEqual(out, ['*x0 x1(g1) x2(g1)', '*y0 y1', '*x0 x2(g1)', '*y0 y1 x1', '*y0 x0 y1 x1']);
});

test('OBSERVED tabs.group: joins at the nearest edge, works across windows, gathers loose tabs in their CURRENT order', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const { wid, ids } = await T.six('q');
    const o = [];
    const g = await chrome.tabs.group({ tabIds: [ids[4], ids[1]], createProperties: { windowId: wid } }); // array order ≠ index order
    o.push(await T.layout(wid));
    await chrome.tabs.group({ tabIds: [ids[5]], groupId: g }); // far right → joins at the right edge
    o.push(await T.layout(wid));
    await chrome.tabs.group({ tabIds: [ids[0]], groupId: g }); // far left → joins at the left edge
    o.push(await T.layout(wid));
    const other = await T.win('r0');
    await T.wait();
    await chrome.tabs.group({ tabIds: [other.tabs[0].id], groupId: g }); // other window: the tab is pulled over
    o.push(await T.layout(wid), String((await chrome.windows.getAll()).some((w) => w.id === other.id)));
    return o;
  });
  assert.equal(out[0], 'q0 q1(g1) q4(g1) q2 q3 q5');
  assert.equal(out[1], 'q0 q1(g1) q4(g1) q5(g1) q2 q3');
  assert.equal(out[2], 'q0(g1) q1(g1) q4(g1) q5(g1) q2 q3');
  assert.equal(out[3], 'q0(g1) q1(g1) q4(g1) q5(g1) r0(g1) q2 q3');
  assert.equal(out[4], 'false', "the other window lost its only tab and closed");
});

test('OBSERVED tabs.group on a pinned tab unpins it', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const w = await T.win('p0'); const p1 = await T.tab(w.id, 'p1');
    await T.wait();
    await chrome.tabs.update(w.tabs[0].id, { pinned: true });
    const o = [await T.layout(w.id)];
    await chrome.tabs.group({ tabIds: [w.tabs[0].id], createProperties: { windowId: w.id } });
    o.push(await T.layout(w.id));
    return o;
  });
  assert.deepEqual(out, ['*p0 p1', 'p0(g1) p1']);
});

test('OBSERVED tabGroups.move lands at exactly `index` (higher or lower), -1 is the end, other windows work', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const { wid, ids } = await T.six('k');
    const g = await chrome.tabs.group({ tabIds: [ids[1], ids[2]], createProperties: { windowId: wid } });
    const o = [];
    await chrome.tabGroups.move(g, { index: 3 });
    o.push(await T.layout(wid));
    await chrome.tabGroups.move(g, { index: 0 });
    o.push(await T.layout(wid));
    await chrome.tabGroups.move(g, { index: -1 });
    o.push(await T.layout(wid));
    const other = await T.win('l0');
    await T.wait();
    await chrome.tabGroups.move(g, { windowId: other.id, index: -1 });
    o.push(await T.layout(other.id), String((await chrome.tabGroups.get(g)).windowId === other.id));
    return o;
  });
  assert.deepEqual(out, ['k0 k3 k4 k1(g1) k2(g1) k5', 'k1(g1) k2(g1) k0 k3 k4 k5', 'k0 k3 k4 k5 k1(g1) k2(g1)', 'l0 k1(g1) k2(g1)', 'true']);
});

test('OBSERVED windows.create({tabId}) takes the tab out of its group; moving a window\'s only tab closes that window', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const { wid, ids } = await T.six('n');
    await chrome.tabs.group({ tabIds: [ids[1], ids[2]], createProperties: { windowId: wid } });
    const nw = await chrome.windows.create({ tabId: ids[1], focused: false });
    const o = [await T.layout(wid), await T.layout(nw.id)];
    const solo = await T.win('s0');
    await T.wait();
    const w2 = await chrome.windows.create({ tabId: solo.tabs[0].id, focused: false });
    const left = (await chrome.windows.getAll()).map((w) => w.id);
    o.push(String(left.includes(solo.id)), String(left.includes(w2.id)));
    return o;
  });
  assert.deepEqual(out, ['n0 n2(g1) n3 n4 n5', 'n1', 'false', 'true']);
});

test('OBSERVED bookmarks.move inside one parent: a LOWER index is exact, a HIGHER index lands one position early', async () => {
  await h.reset();
  const out = await h.call(async () => {
    const f = await chrome.bookmarks.create({ parentId: '1', title: 'F' });
    const bs = [];
    for (const n of ['a', 'b', 'c', 'd', 'e']) bs.push(await chrome.bookmarks.create({ parentId: f.id, title: n, url: `https://${n}.test/` }));
    const order = async () => (await chrome.bookmarks.getChildren(f.id)).map((c) => c.title).join('');
    const o = [];
    await chrome.bookmarks.move(bs[0].id, { parentId: f.id, index: 2 }); o.push(await order());
    await chrome.bookmarks.move(bs[0].id, { parentId: f.id, index: 4 }); o.push(await order());
    await chrome.bookmarks.move(bs[0].id, { parentId: f.id, index: 0 }); o.push(await order());
    return o;
  });
  assert.deepEqual(out, ['bacde', 'bcdae', 'abcde']);
});

test('OBSERVED tabs.create at an index inside a group joins it; without an index the tab is appended outside any group', async () => {
  await h.reset();
  const out = await sw(async (arg) => {
    T.base = arg.base;
    const { wid, ids } = await T.six('c');
    await chrome.tabs.group({ tabIds: [ids[3], ids[4], ids[5]], createProperties: { windowId: wid } });
    const mid = await chrome.tabs.create({ windowId: wid, url: T.base + '/mid', index: 4, active: false });
    T.names.set(mid.id, 'mid');
    const end = await chrome.tabs.create({ windowId: wid, url: T.base + '/end', active: false });
    T.names.set(end.id, 'end');
    return [await T.layout(wid)];
  });
  assert.equal(out[0], 'c0 c1 c2 c3(g1) mid(g1) c4(g1) c5(g1) end');
});
