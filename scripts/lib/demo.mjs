// Shared by scripts/demo.mjs (headed) and scripts/record.mjs (headless): launch Playwright's bundled Chromium with the
// unpacked extension in a throwaway profile, seed the demo state with real pages, open the editor.
// These two scripts are the only ones allowed to use the real internet.

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST = resolve(ROOT, 'dist');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch with a profile recreated from scratch at .tmp/<name>. Never touches a real browser profile. */
export async function launchDemo({ name, headless, args = [], contextOptions = {} }) {
  const profile = resolve(ROOT, '.tmp', name);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless,
    viewport: null,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, ...args],
    ...contextOptions,
  });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 20000 }));
  const call = async (fn, arg) => {
    const w = context.serviceWorkers().find((x) => x.url().startsWith(new URL(sw.url()).origin)) || sw;
    return w.evaluate(fn, arg);
  };
  const cleanup = async () => {
    try { await context.close(); } catch { /* already closed */ }
    rmSync(profile, { recursive: true, force: true });
  };
  return { context, call, cleanup, profile };
}

export const SEED = {
  window1: [
    { url: 'https://neovim.io/', pinned: true },
    { url: 'https://github.com/stevearc/oil.nvim' },
    { group: 'Research', color: 'blue', urls: ['https://arxiv.org/abs/1706.03762', 'https://arxiv.org/abs/2005.14165'] },
    { url: 'https://news.ycombinator.com/' },
    { url: 'https://en.wikipedia.org/wiki/Vim_(text_editor)' },
  ],
  window2: [
    { url: 'https://github.com/minhyeoky/tmux-oil.nvim' },
    { url: 'https://codemirror.net/' },
    { url: 'https://developer.chrome.com/docs/extensions/reference/api/tabs' },
  ],
  bar: [
    { folder: 'Dev', children: [{ title: 'GitHub', url: 'https://github.com/' }, { title: 'MDN', url: 'https://developer.mozilla.org/' }] },
    { folder: 'Read later', children: [] },
  ],
  other: [{ title: 'Wikipedia', url: 'https://www.wikipedia.org/' }],
};

/** Create the demo windows/groups/bookmarks. `layout` positions the two windows (headed demo only). */
export async function seedDemo(call, { layout = null, waitMs = 30000, seed = SEED } = {}) {
  await call(async ({ seed, layout, waitMs }) => {
    const mkWindow = async (items, bounds) => {
      const flat = [];
      for (const it of items) {
        if (it.group) for (const u of it.urls) flat.push({ url: u, group: it });
        else flat.push(it);
      }
      let w;
      try {
        w = await chrome.windows.create({ url: flat[0].url, focused: false, ...(bounds || {}) });
      } catch {
        w = await chrome.windows.create({ url: flat[0].url, focused: false }); // bounds off the screen: let Chrome place it
      }
      const ids = [w.tabs[0].id];
      for (const f of flat.slice(1)) ids.push((await chrome.tabs.create({ windowId: w.id, url: f.url, active: false })).id);
      for (let i = 0; i < flat.length; i++) if (flat[i].pinned) await chrome.tabs.update(ids[i], { pinned: true });
      const groups = new Map();
      flat.forEach((f, i) => { if (f.group) { if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(ids[i]); } });
      for (const [g, tabIds] of groups) {
        const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId: w.id } });
        await chrome.tabGroups.update(gid, { title: g.group, color: g.color });
      }
      return { w, ids };
    };
    const one = await mkWindow(seed.window1, layout && layout.window1);
    const two = await mkWindow(seed.window2, layout && layout.window2);
    // drop the blank window the browser started with (and any other leftovers)
    for (const w of await chrome.windows.getAll({ populate: true })) {
      if (w.type === 'normal' && w.id !== one.w.id && w.id !== two.w.id) await chrome.windows.remove(w.id);
    }
    const mk = async (parentId, items) => {
      for (const it of items) {
        if (it.folder) { const f = await chrome.bookmarks.create({ parentId, title: it.folder }); await mk(f.id, it.children); }
        else await chrome.bookmarks.create({ parentId, title: it.title, url: it.url });
      }
    };
    const tree = await chrome.bookmarks.getTree();
    const barId = tree[0].children.find((c) => c.folderType === 'bookmarks-bar' || c.id === '1').id;
    const otherId = tree[0].children.find((c) => c.folderType === 'other' || c.id === '2').id;
    await mk(barId, seed.bar);
    await mk(otherId, seed.other);
    // let the pages load so titles are real (bounded: a slow site must not stall the demo)
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      const tabs = await chrome.tabs.query({});
      if (tabs.every((t) => t.status === 'complete')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await chrome.windows.update(one.w.id, { focused: true });
  }, { seed, layout, waitMs });
}
