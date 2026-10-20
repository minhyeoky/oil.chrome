// chrome API → raw snapshot (see model.js for the shape). `api` is the `chrome` namespace (or a stand-in).

const startsWith = (s, prefix) => !!prefix && typeof s === 'string' && s.startsWith(prefix);

/**
 * @param api            chrome.* namespace
 * @param opts.editorUrl URL of the editor page; tabs showing it never appear in the outline (double filter: the
 *                       editor window is a popup, and normal windows are the only ones listed)
 * @param opts.focusWindowId window to mark as focused when no normal window has focus (the editor itself does)
 */
export async function readSnapshot(api, { editorUrl = '', focusWindowId = null } = {}) {
  const [wins, groups, tree] = await Promise.all([
    api.windows.getAll({ populate: true }),
    api.tabGroups.query({}),
    api.bookmarks.getTree(),
  ]);

  const windows = [];
  for (const w of wins) {
    if (w.type !== 'normal') continue;
    const tabs = (w.tabs || [])
      .filter((t) => !startsWith(t.url, editorUrl) && !startsWith(t.pendingUrl, editorUrl))
      .map((t) => ({
        id: t.id, index: t.index, title: t.title, url: t.url, pendingUrl: t.pendingUrl,
        pinned: !!t.pinned, active: !!t.active, groupId: t.groupId ?? -1,
      }));
    if (tabs.length) windows.push({ id: w.id, focused: !!w.focused, tabs });
  }
  if (focusWindowId != null && !windows.some((w) => w.focused)) {
    const hit = windows.find((w) => w.id === focusWindowId);
    if (hit) hit.focused = true;
  }
  const kept = new Set(windows.map((w) => w.id));

  const node = (n) => (n.url != null && !n.children
    ? { id: n.id, title: n.title, url: n.url }
    : { id: n.id, title: n.title, children: (n.children || []).map(node) });
  const roots = ((tree[0] && tree[0].children) || []).filter((n) => !n.unmodifiable).map(node);

  return {
    windows,
    groups: groups.filter((g) => kept.has(g.windowId)).map((g) => ({ id: g.id, windowId: g.windowId, title: g.title, color: g.color, collapsed: g.collapsed })),
    bookmarks: roots,
  };
}
