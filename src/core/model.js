// Snapshot normalisation and indexing (DESIGN.md §2 "정규화"). Pure: no chrome APIs.
//
// Raw snapshot shape (what snapshot.js produces; tests build it by hand):
//   { windows:[{ id, focused, tabs:[{ id, index, title, url, pendingUrl?, pinned, active, groupId }] }],
//     groups:[{ id, windowId, title, color, collapsed? }],
//     bookmarks:[ root nodes: { id, title, url?, children? } ] }
// groupId === -1 / undefined / null means "not grouped". Tab/window/group ids are numbers, bookmark ids strings.

import { normalizeTitle, normalizeUrl } from './grammar.js';

export function tabUrl(t) {
  const u = normalizeUrl(t.url) || normalizeUrl(t.pendingUrl);
  return u || 'about:blank';
}

export function normalizeSnapshot(raw) {
  const windows = [...(raw.windows || [])]
    .sort((a, b) => a.id - b.id)
    .map((w) => ({
      id: w.id,
      focused: !!w.focused,
      tabs: [...(w.tabs || [])]
        .sort((a, b) => a.index - b.index)
        .map((t, i) => ({
          id: t.id,
          index: i,
          title: normalizeTitle(t.title),
          url: tabUrl(t),
          pinned: !!t.pinned,
          active: !!t.active,
          groupId: t.groupId == null || t.groupId < 0 ? -1 : t.groupId,
        })),
    }));
  const groups = (raw.groups || []).map((g) => ({
    id: g.id,
    windowId: g.windowId,
    title: normalizeTitle(g.title),
    color: g.color || 'grey',
    collapsed: !!g.collapsed,
  }));
  const node = (n) => {
    const out = { id: String(n.id), title: normalizeTitle(n.title) };
    if (n.url != null && n.children == null) out.url = normalizeUrl(n.url);
    else out.children = (n.children || []).map(node);
    return out;
  };
  return { windows, groups, bookmarks: (raw.bookmarks || []).map(node) };
}

/**
 * Index a snapshot by entity key (`w12`, `t12`, `g5`, `b11`).
 * Windows are ordered by id; `ordinal` (1-based) names them "Window N".
 */
export function indexSnapshot(raw) {
  const snap = normalizeSnapshot(raw);
  const windows = new Map();
  const tabs = new Map();
  const groups = new Map();
  const bm = new Map();
  const windowKeys = [];
  const rootKeys = [];

  snap.windows.forEach((w, wi) => {
    const wk = `w${w.id}`;
    windowKeys.push(wk);
    windows.set(wk, { key: wk, id: w.id, ordinal: wi + 1, focused: w.focused, tabKeys: [] });
  });
  const groupsById = new Map(snap.groups.map((g) => [g.id, g]));
  for (const w of snap.windows) {
    const wk = `w${w.id}`;
    for (const t of w.tabs) {
      const tk = `t${t.id}`;
      const gk = t.groupId >= 0 && groupsById.has(t.groupId) ? `g${t.groupId}` : null;
      tabs.set(tk, { key: tk, id: t.id, windowKey: wk, index: t.index, title: t.title, url: t.url, pinned: t.pinned, active: t.active, groupKey: gk });
      windows.get(wk).tabKeys.push(tk);
      if (gk) {
        if (!groups.has(gk)) {
          const g = groupsById.get(t.groupId);
          groups.set(gk, { key: gk, id: g.id, windowKey: wk, title: g.title, color: g.color, collapsed: g.collapsed, tabKeys: [] });
        }
        groups.get(gk).tabKeys.push(tk);
      }
    }
  }
  // groups without tabs cannot exist in Chrome; ignore them.

  const walk = (n, parentKey, index) => {
    const key = `b${n.id}`;
    const rec = {
      key, id: n.id, parentKey, index, title: n.title, url: n.url ?? null,
      isFolder: n.url == null, isRoot: parentKey === null, childKeys: [],
    };
    bm.set(key, rec);
    if (n.children) n.children.forEach((c, i) => { rec.childKeys.push(`b${c.id}`); walk(c, key, i); });
    return rec;
  };
  snap.bookmarks.forEach((r, i) => { walk(r, null, i); rootKeys.push(`b${r.id}`); });

  return { snap, windows, tabs, groups, bm, windowKeys, rootKeys };
}

/** Window contents as items in index order: ungrouped tabs and group blocks. */
export function windowItems(ix, windowKey) {
  const win = ix.windows.get(windowKey);
  const items = [];
  const seen = new Set();
  for (const tk of win.tabKeys) {
    const t = ix.tabs.get(tk);
    if (!t.groupKey) { items.push({ type: 'tab', key: tk }); continue; }
    if (seen.has(t.groupKey)) continue;
    seen.add(t.groupKey);
    items.push({ type: 'group', key: t.groupKey, members: [...ix.groups.get(t.groupKey).tabKeys] });
  }
  return items;
}

/** Number of bookmark (non-folder) descendants of a bookmark folder. */
export function countBookmarks(ix, key) {
  let n = 0;
  const rec = ix.bm.get(key);
  for (const ck of rec.childKeys) {
    const c = ix.bm.get(ck);
    n += c.isFolder ? countBookmarks(ix, ck) : 1;
  }
  return n;
}
