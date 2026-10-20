// e2e harness: Playwright's bundled Chromium (headless new mode) with the unpacked extension, a throwaway
// profile under .tmp/, and a local http server so no test touches the internet.
//
// The pure engine + executor is injected into the extension's service worker as `OilCore` so core scenarios
// run against real Chrome state exactly as the editor would run them; keystroke tests use the real editor page.

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST = resolve(ROOT, 'dist');
export const TMP = resolve(ROOT, '.tmp');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let coreBundle = null;
async function coreCode() {
  if (!coreBundle) {
    const r = await build({
      entryPoints: [resolve(ROOT, 'src/core/index.js')], bundle: true, format: 'iife', globalName: 'OilCore',
      write: false, target: 'chrome120', logLevel: 'silent',
    });
    coreBundle = r.outputFiles[0].text;
  }
  return coreBundle;
}

/** Local pages: /p/<name> → <title>Name</title>. */
export async function startServer() {
  const server = createServer((req, res) => {
    const m = /^\/p\/([\w-]+)/.exec(req.url || '');
    if (!m) { res.writeHead(404); res.end(); return; }
    const name = m[1];
    const title = name.charAt(0).toUpperCase() + name.slice(1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    url: (name) => `http://127.0.0.1:${port}/p/${name}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

export const nameOfUrl = (url) => {
  const m = /\/p\/([\w-]+)/.exec(url || '');
  return m ? m[1] : url;
};

export async function launch({ headless = true, name = 'e2e', args = [] } = {}) {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(resolve(TMP, `${name}-`));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, ...args],
    viewport: null,
  });
  let sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = new URL(sw.url()).host;
  const server = await startServer();
  const code = await coreCode();

  const getSw = async () => {
    const live = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`));
    if (live) return (sw = live);
    // the worker idled out: poke the extension to wake it
    const p = await context.newPage();
    await p.goto(`chrome-extension://${extId}/editor.html`).catch(() => {});
    await p.close();
    return (sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 })));
  };
  /** Run `fn(arg)` inside the service worker (where `chrome.*`, `oilOpenEditor` and, after `core`, `OilCore` live). */
  const call = async (fn, arg, { core = false } = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const w = await getSw();
        if (core && !(await w.evaluate(() => typeof globalThis.OilCore !== 'undefined'))) await w.evaluate(code);
        return await w.evaluate(fn, arg);
      } catch (e) {
        if (attempt >= 2 || !/closed|destroyed|not found|detached|Target/i.test(String(e))) throw e;
      }
    }
  };
  const close = async () => {
    try { await context.close(); } catch { /* already gone */ }
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
  const h = { context, extId, server, dir, call, close, url: server.url, editorUrl: `chrome-extension://${extId}/editor.html` };

  // A popup keeps the browser alive while a test closes every normal window; it is never listed (type !== normal).
  await call(async () => { await chrome.windows.create({ type: 'popup', url: 'about:blank', focused: false, width: 200, height: 200 }); });

  /** Close every normal window, drop all bookmarks, clear the journal. */
  h.reset = async () => {
    await call(async () => {
      for (const w of await chrome.windows.getAll()) if (w.type === 'normal') await chrome.windows.remove(w.id);
      const tree = await chrome.bookmarks.getTree();
      for (const root of tree[0].children) for (const c of root.children || []) await chrome.bookmarks.removeTree(c.id);
      await chrome.storage.local.clear();
    });
  };

  /**
   * Seed from a spec. window = array of items: 'name' | { pin:'name' } | { group:'Title', color:'blue', tabs:['a','b'] }
   * bookmarks = { bar:[...], other:[...] } with items ['Title','page'] | { folder:'Title', children:[...] }
   * Returns the live state as `h.state()` would.
   */
  h.seed = async ({ windows = [], bookmarks = {} }) => {
    await h.reset();
    await call(async ({ windows, bookmarks, base }) => {
      const wait = async (tabIds) => {
        for (let i = 0; i < 100; i++) {
          const ts = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
          if (ts.every((t) => t.status === 'complete' && t.title)) return;
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      const allTabs = [];
      for (const spec of windows) {
        const flat = [];
        for (const it of spec) {
          if (typeof it === 'string') flat.push({ name: it });
          else if (it.pin) flat.push({ name: it.pin, pin: true });
          else for (const n of it.tabs) flat.push({ name: n, group: it });
        }
        const w = await chrome.windows.create({ url: `${base}/${flat[0].name}`, focused: false });
        const ids = [w.tabs[0].id];
        for (const f of flat.slice(1)) ids.push((await chrome.tabs.create({ windowId: w.id, url: `${base}/${f.name}`, active: false })).id);
        allTabs.push(...ids);
        for (let i = 0; i < flat.length; i++) if (flat[i].pin) await chrome.tabs.update(ids[i], { pinned: true });
        const seen = new Map();
        for (let i = 0; i < flat.length; i++) {
          const g = flat[i].group;
          if (!g) continue;
          if (!seen.has(g)) seen.set(g, []);
          seen.get(g).push(ids[i]);
        }
        for (const [g, tabIds] of seen) {
          const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId: w.id } });
          await chrome.tabGroups.update(gid, { title: g.group, color: g.color || 'grey' });
        }
      }
      await wait(allTabs);
      const tree = await chrome.bookmarks.getTree();
      const rootOf = { bar: tree[0].children.find((c) => c.folderType === 'bookmarks-bar' || c.id === '1').id, other: tree[0].children.find((c) => c.folderType === 'other' || c.id === '2').id };
      const mk = async (parentId, items) => {
        for (const it of items) {
          if (Array.isArray(it)) await chrome.bookmarks.create({ parentId, title: it[0], url: `${base}/${it[1]}` });
          else { const f = await chrome.bookmarks.create({ parentId, title: it.folder }); await mk(f.id, it.children || []); }
        }
      };
      for (const [k, items] of Object.entries(bookmarks)) await mk(rootOf[k], items);
    }, { windows, bookmarks, base: `http://127.0.0.1:${server.port}/p` });
    return h.state();
  };

  /** Canonical live state: windows (by id) → items: 'name' | { group, color, tabs:[...] }; pinned tabs as '*name'. */
  h.state = async () => call(async () => {
    const nameOf = (u) => { const m = /\/p\/([\w-]+)/.exec(u || ''); return m ? m[1] : u; };
    const wins = (await chrome.windows.getAll({ populate: true })).filter((w) => w.type === 'normal').sort((a, b) => a.id - b.id);
    const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
    const outWins = [];
    for (const w of wins) {
      const items = [];
      for (const t of [...w.tabs].sort((a, b) => a.index - b.index)) {
        const n = (t.pinned ? '*' : '') + nameOf(t.url || t.pendingUrl);
        if (t.groupId >= 0) {
          const last = items[items.length - 1];
          if (last && last.gid === t.groupId) last.tabs.push(n);
          else { const g = groups.get(t.groupId); items.push({ gid: t.groupId, group: g.title, color: g.color, tabs: [n] }); }
        } else items.push(n);
      }
      outWins.push(items.map((i) => (typeof i === 'string' ? i : { group: i.group, color: i.color, tabs: i.tabs })));
    }
    const tree = await chrome.bookmarks.getTree();
    const bm = (n) => (n.url != null ? [n.title, nameOf(n.url)] : { folder: n.title, children: (n.children || []).map(bm) });
    const roots = {};
    for (const r of tree[0].children) roots[r.folderType === 'bookmarks-bar' || r.id === '1' ? 'bar' : r.folderType === 'other' || r.id === '2' ? 'other' : r.title] = (r.children || []).map(bm);
    return { windows: outWins, bookmarks: roots };
  });

  /** render the current live state: { text, snapshot } */
  h.render = async () => call(async () => {
    const snapshot = await OilCore.readSnapshot(chrome, { editorUrl: chrome.runtime.getURL('editor.html') });
    return { text: OilCore.render(snapshot).text, snapshot };
  }, undefined, { core: true });

  /** plan(S, fresh, text) then apply; returns { plan, report } */
  h.applyText = async (snapshot, text) => call(async ({ snapshot, text }) => {
    const fresh = await OilCore.readSnapshot(chrome, { editorUrl: chrome.runtime.getURL('editor.html') });
    const plan = OilCore.plan(snapshot, fresh, text);
    const report = await OilCore.apply(chrome, plan);
    return { plan, report };
  }, { snapshot, text }, { core: true });

  /** plan only (no apply) against the fresh state */
  h.planText = async (snapshot, text) => call(async ({ snapshot, text }) => {
    const fresh = await OilCore.readSnapshot(chrome, { editorUrl: chrome.runtime.getURL('editor.html') });
    return OilCore.plan(snapshot, fresh, text);
  }, { snapshot, text }, { core: true });

  /** state() once every tab has finished loading (navigations and new tabs settle asynchronously) */
  h.settledState = async () => {
    for (let i = 0; i < 100; i++) {
      const busy = await call(async () => (await chrome.tabs.query({})).some((t) => t.status !== 'complete' || t.pendingUrl));
      if (!busy) break;
      await sleep(50);
    }
    return h.state();
  };

  return h;
}
