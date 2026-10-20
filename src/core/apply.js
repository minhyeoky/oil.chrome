// apply(api, plan) → report  (DESIGN.md §6: create → place → update → delete).
//
// `api` is the `chrome` namespace (or a stand-in). The plan's `actions` drive creation, updates and deletion;
// `plan.desired` drives placement, which is a reconcile loop — "move until the layout is what we want, then verify" —
// instead of index arithmetic. Chrome behaviours this relies on were observed (test/e2e/chrome-behavior.test.mjs):
//   · tabs.move/tabGroups.move land at exactly `index`, even when moving to a higher index
//   · tabs.move to an index strictly inside a group (members on both sides) joins it; to the group's edges it does not
//   · tabs.move to another window leaves the group; tabs.group({groupId}) pulls tabs across windows itself
//   · tabGroups.move to another window takes every tab of the group along, whatever the plan thinks of it
//   · a window closes when its last tab leaves it, and tabs.create into a closed window is refused
//   · unpinned tabs stay behind every pinned tab: a move into the pinned region lands right behind it
//   · tabs.create without an index appends after the last tab, outside any group
//   · tabs.group rejects the whole call when one tab id is unknown
//   · bookmarks.move inside one parent to a higher index lands one position early → only ever move to lower indexes

const MAX_PASSES = 4;

const sameArray = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const msg = (e) => String((e && e.message) || e);

export async function apply(api, plan, { journalLimit = 20 } = {}) {
  const report = {
    refused: false, applied: 0, errors: [], warnings: plan.warnings.map((w) => w.message), mismatches: [],
    skippedDeletes: false, journaled: null,
  };
  if (plan.errors.length) {
    report.refused = true;
    report.errors = plan.errors.map((e) => ({ op: 'plan', message: e.message }));
    return report;
  }

  const { actions, desired } = plan;
  const ids = new Map();
  const idOf = (key) => {
    if (ids.has(key)) return ids.get(key);
    if (key[0] === 'b') return key.slice(1);
    if (key[0] === 'w' || key[0] === 't' || key[0] === 'g') return Number(key.slice(1));
    return undefined;
  };
  const fail = (op, e) => report.errors.push({ op, message: msg(e) });
  const step = async (op, fn) => {
    try { const value = await fn(); report.applied++; return { ok: true, value }; } catch (e) { fail(op, e); return { ok: false }; }
  };
  const groupExists = async (gid) => { try { await api.tabGroups.get(gid); return true; } catch { return false; } };
  const readTabs = async () => new Map((await api.tabs.query({})).map((t) => [t.id, t]));
  const readWindow = async (wid) => (await api.tabs.query({ windowId: wid })).sort((a, b) => a.index - b.index);
  const flatten = (Wd) => {
    const out = [];
    for (const it of Wd.items) {
      if (it.type === 'tab') out.push({ key: it.key, id: idOf(it.key), group: null, pinned: !!it.pinned });
      else for (const m of it.members) out.push({ key: m, id: idOf(m), group: it.key, pinned: false });
    }
    return out.filter((t) => t.id !== undefined);
  };

  // ── 0. placeholders ──────────────────────────────────────────────────────
  // Chrome closes a window when its last tab leaves, and later steps (new tabs, tabs coming over) still need it. A window
  // all of whose tabs leave it gets an about:blank tab until placement is done. A tab leaves when the desired state puts
  // it in another window, or when its group moves to another window (tabGroups.move takes every tab in the group — one
  // the plan closes later or does not know too). A window that keeps a tab — one the plan closes later, or one it does
  // not know — is never emptied. The placeholder is appended (outside any group) and never moved; placement works from
  // the front, so it stays behind everything placed.
  const placeholders = [];
  {
    const homeOf = new Map(); // tab id → key of the window the desired state puts it in
    for (const Wd of desired.windows) for (const t of flatten(Wd)) homeOf.set(t.id, Wd.key);
    const carried = new Set(actions.filter((a) => a.kind === 'move-group').map((a) => idOf(a.key)));
    for (const Wd of desired.windows) {
      if (Wd.isNew || !Wd.items.length) continue;
      try {
        const live = await readWindow(idOf(Wd.key));
        const leaves = (t) => carried.has(t.groupId) || (homeOf.has(t.id) && homeOf.get(t.id) !== Wd.key);
        if (!live.length || !live.every(leaves)) continue;
        placeholders.push((await api.tabs.create({ windowId: idOf(Wd.key), url: 'about:blank', active: false })).id);
      } catch (e) { fail('placeholder', e); }
    }
  }

  // ── 1. create ────────────────────────────────────────────────────────────
  const newTabAct = new Map(actions.filter((a) => a.kind === 'new-tab').map((a) => [a.key, a]));
  const realised = new Set();
  for (const a of actions) {
    if (a.kind !== 'new-window') continue;
    await step('new window', async () => {
      const firstAct = newTabAct.get(a.first);
      const w = firstAct
        ? await api.windows.create({ url: firstAct.url, focused: false })
        : await api.windows.create({ tabId: idOf(a.first), focused: false });
      ids.set(a.key, w.id);
      if (firstAct) { ids.set(a.first, w.tabs[0].id); realised.add(a.first); }
    });
  }
  for (const a of newTabAct.values()) {
    if (realised.has(a.key)) continue;
    const wid = idOf(a.window);
    if (wid === undefined) { fail(`new tab ${a.url}`, 'its window could not be created'); continue; }
    await step(`new tab ${a.url}`, async () => {
      const t = await api.tabs.create({ windowId: wid, url: a.url, active: false });
      ids.set(a.key, t.id);
    });
  }
  for (const a of actions) {
    if (a.kind !== 'new-folder' && a.kind !== 'new-bookmark') continue;
    const parentId = idOf(a.parent);
    if (parentId === undefined) { fail(`new ${a.kind.slice(4)} ${a.title}`, 'its parent folder could not be created'); continue; }
    await step(`new ${a.kind.slice(4)} ${a.title}`, async () => {
      const n = await api.bookmarks.create(a.kind === 'new-folder' ? { parentId, title: a.title } : { parentId, title: a.title, url: a.url });
      ids.set(a.key, n.id);
    });
  }

  // ── 2. place: tab groups and tabs ────────────────────────────────────────
  for (const a of actions) {
    if (a.kind !== 'move-group') continue;
    const gid = idOf(a.key);
    const wid = idOf(a.window);
    if (wid === undefined) continue;
    if (!(await groupExists(gid))) continue; // dissolved in the meantime; re-created when its members are grouped
    await step('move group', () => api.tabGroups.move(gid, { windowId: wid, index: -1 }));
  }

  const groupIdOf = (key) => (key ? ids.get(key) ?? (key[0] === 'g' ? Number(key.slice(1)) : undefined) : -1);

  async function placeItems(Wd, winId) {
    let pos = 0;
    let pinnedDone = false;
    const settle = async (tabId, index) => {
      const live = await readWindow(winId);
      if (live[index] && live[index].id === tabId) return;
      await step('move tab', () => api.tabs.move(tabId, { index }));
    };
    for (const it of Wd.items) {
      if (!pinnedDone && !(it.type === 'tab' && it.pinned)) {
        // the listed pinned tabs sit in front now; pinned tabs the desired state does not list (to be closed, or pinned
        // outside meanwhile) come behind them, and the unpinned items start behind all of them
        pinnedDone = true;
        pos = (await readWindow(winId)).filter((t) => t.pinned).length;
      }
      const memberIds = (it.type === 'tab' ? [it.key] : it.members).map(idOf).filter((x) => x !== undefined);
      if (it.type === 'group') {
        const gid = groupIdOf(it.key);
        if (gid !== undefined && (await groupExists(gid))) {
          const live = await readWindow(winId);
          const start = live.findIndex((t) => t.groupId === gid);
          if (start >= 0 && start !== pos) await step('move group', () => api.tabGroups.move(gid, { index: pos }));
        }
      }
      for (let j = 0; j < memberIds.length; j++) await settle(memberIds[j], pos + j);
      pos += memberIds.length;
    }
  }

  async function reconcileWindow(Wd, problems) {
    const winId = idOf(Wd.key);
    if (winId === undefined) { problems.push(`window ${Wd.key} was not created`); return; }
    const want = flatten(Wd);
    if (!want.length) return;

    // tabs living in another window come over first (this also takes them out of their group)
    let all = await readTabs();
    for (const t of want) {
      const cur = all.get(t.id);
      if (cur && cur.windowId !== winId) await step('move tab to window', () => api.tabs.move(t.id, { windowId: winId, index: -1 }));
    }
    // moving a tab between windows unpins it: pin it again (it joins the end of the pinned tabs)
    all = await readTabs();
    for (const t of want) {
      const cur = all.get(t.id);
      if (t.pinned && cur && !cur.pinned) await step('pin tab', () => api.tabs.update(t.id, { pinned: true }));
    }
    // tabs whose group changes leave their current group first
    all = await readTabs();
    const leaving = want.filter((t) => {
      const cur = all.get(t.id);
      return cur && cur.groupId !== -1 && cur.groupId !== groupIdOf(t.group);
    }).map((t) => t.id);
    if (leaving.length) await step('ungroup', () => api.tabs.ungroup(leaving));

    // order: only when the known tabs are not already in the wanted relative order
    const wantIds = want.map((t) => t.id);
    const known = new Set(wantIds);
    let live = await readWindow(winId);
    if (!sameArray(live.filter((t) => known.has(t.id)).map((t) => t.id), wantIds)) {
      await placeItems(Wd, winId);
    }

    // group membership
    for (const it of Wd.items) {
      if (it.type !== 'group') continue;
      const members = it.members.map(idOf).filter((x) => x !== undefined);
      if (!members.length) continue;
      const gid = groupIdOf(it.key);
      const cur = await readTabs();
      if (gid !== undefined && (await groupExists(gid))) {
        const missing = members.filter((id) => cur.get(id) && cur.get(id).groupId !== gid);
        if (missing.length) await step('group tabs', () => api.tabs.group({ tabIds: missing, groupId: gid }));
      } else {
        await step('new group', async () => {
          const created = await api.tabs.group({ tabIds: members, createProperties: { windowId: winId } });
          ids.set(it.key, created);
          const g = desired.groups[it.key] || {};
          const props = {};
          if (g.title) props.title = g.title;
          if (g.color) props.color = g.color;
          if (Object.keys(props).length) await api.tabGroups.update(created, props);
        });
      }
    }

    // groups may have shifted tabs around: settle the order once more, then verify
    live = await readWindow(winId);
    if (!sameArray(live.filter((t) => known.has(t.id)).map((t) => t.id), wantIds)) await placeItems(Wd, winId);
    live = await readWindow(winId);
    const liveIds = live.filter((t) => known.has(t.id)).map((t) => t.id);
    if (!sameArray(liveIds, wantIds)) problems.push(`order of ${Wd.key}: wanted ${wantIds.join(',')} got ${liveIds.join(',')}`);
    const byId = new Map(live.map((t) => [t.id, t]));
    const newGroupIds = new Map();
    for (const t of want) {
      const cur = byId.get(t.id);
      if (!cur) { problems.push(`tab ${t.key} is not in ${Wd.key}`); continue; }
      if (t.group === null) { if (cur.groupId !== -1) problems.push(`tab ${t.key} should be ungrouped`); continue; }
      const gid = groupIdOf(t.group);
      if (gid !== undefined && cur.groupId !== gid) problems.push(`tab ${t.key} should be in group ${t.group}`);
      if (gid === undefined) {
        if (!newGroupIds.has(t.group)) newGroupIds.set(t.group, cur.groupId);
        else if (newGroupIds.get(t.group) !== cur.groupId) problems.push(`group ${t.group} is split`);
      }
    }
  }

  // Tabs about to be closed are taken out of their groups first: left inside a span they would make every tab
  // placed next to them join the group (tabs.move into the interior of a group joins it). They go back at the end
  // when the deletes are skipped.
  const ungroupedToClose = new Map(); // tab id → the group it was taken out of
  let tabProblems = [];
  try {
    const closing = actions.filter((a) => a.kind === 'close-tab').map((a) => idOf(a.key));
    if (closing.length) {
      const all = await readTabs();
      const grouped = closing.filter((id) => all.get(id) && all.get(id).groupId !== -1);
      if (grouped.length && (await step('ungroup tabs to close', () => api.tabs.ungroup(grouped))).ok) {
        for (const id of grouped) ungroupedToClose.set(id, all.get(id).groupId);
      }
    }
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      tabProblems = [];
      for (const Wd of desired.windows) await reconcileWindow(Wd, tabProblems);
      if (!tabProblems.length) break;
    }
  } finally {
    // placement is done: the windows the placeholders kept open hold their final tabs now
    for (const id of placeholders) {
      try { await api.tabs.remove(id); } catch { /* a leftover about:blank tab is harmless and never reported */ }
    }
  }

  // ── 2b. place: bookmarks (always to a lower index inside one parent) ─────
  async function placeBookmarks() {
    const failed = [];
    for (const f of desired.folders) {
      const parentId = idOf(f.key);
      if (parentId === undefined) continue;
      const kids = f.children.map(idOf).filter((x) => x !== undefined);
      try {
        let live = (await api.bookmarks.getChildren(parentId)).map((c) => c.id);
        for (let i = 0; i < kids.length; i++) {
          if (live[i] === kids[i]) continue;
          const r = await step('move bookmark', () => api.bookmarks.move(kids[i], { parentId, index: i }));
          if (!r.ok) { failed.push([f, i]); }
          live = (await api.bookmarks.getChildren(parentId)).map((c) => c.id);
        }
      } catch (e) { fail('move bookmark', e); failed.push([f, -1]); } // the folder was removed outside meanwhile
    }
    return failed;
  }
  const bmFailed = await placeBookmarks();
  let bookmarkProblems = [];
  if (bmFailed.length) {
    // e.g. a folder that has to move out of its new descendant first: one more sweep
    report.errors = report.errors.filter((e) => e.op !== 'move bookmark');
    await placeBookmarks();
  }
  for (const f of desired.folders) {
    const parentId = idOf(f.key);
    if (parentId === undefined) continue;
    const kids = f.children.map(idOf).filter((x) => x !== undefined);
    let live;
    try { live = (await api.bookmarks.getChildren(parentId)).map((c) => c.id).filter((id) => kids.includes(id)); } catch {
      bookmarkProblems.push(`folder ${f.key} is gone`);
      continue;
    }
    if (!sameArray(live, kids)) bookmarkProblems.push(`order of ${f.key}: wanted ${kids.join(',')} got ${live.join(',')}`);
  }

  // ── 3. update ────────────────────────────────────────────────────────────
  for (const a of actions) {
    if (a.kind === 'navigate-tab') {
      await step(`navigate ${a.to}`, () => api.tabs.update(idOf(a.key), { url: a.to }));
    } else if (a.kind === 'edit-group') {
      const gid = groupIdOf(a.key);
      if (gid !== undefined && (await groupExists(gid))) await step('edit group', () => api.tabGroups.update(gid, a.changes));
    } else if (a.kind === 'edit-bookmark' || a.kind === 'edit-folder') {
      await step('edit bookmark', () => api.bookmarks.update(idOf(a.key), a.changes));
    }
  }

  report.mismatches = [...tabProblems, ...bookmarkProblems];

  // ── 4. delete (skipped wholesale after any error: never lose the original of a failed move) ─────
  const closes = actions.filter((a) => a.kind === 'close-tab');
  const deletes = actions.filter((a) => a.kind === 'delete-bookmark' || a.kind === 'delete-folder');
  if (closes.length || deletes.length) {
    if (report.errors.length) {
      report.skippedDeletes = true;
    } else {
      // the tabs may have navigated since the snapshot: journal what they are now, the planned values for one that cannot be read
      const tabsNow = [];
      for (const a of closes) {
        try {
          const t = await api.tabs.get(idOf(a.key));
          tabsNow.push({ url: t.url || t.pendingUrl || a.url, title: t.title || a.title });
        } catch { tabsNow.push({ url: a.url, title: a.title }); }
      }
      const entry = { ts: Date.now(), tabs: tabsNow, bookmarks: [] };
      for (const a of deletes) {
        try {
          const sub = await api.bookmarks.getSubTree(idOf(a.key));
          entry.bookmarks.push(...sub);
          if (a.kind === 'delete-folder' && a.known) {
            // removeTree takes everything inside: refuse when something was added since the plan (e.g. while the
            // confirmation was open) — the plan only guards what it saw
            const extra = [];
            const walk = (n) => { if (!a.known.includes(`b${n.id}`)) extra.push(n.title || n.url || n.id); (n.children || []).forEach(walk); };
            sub.forEach(walk);
            if (extra.length) fail(`delete ${a.title}`, `the folder now holds bookmarks added outside (${extra.join(', ')}); nothing was deleted`);
          }
        } catch (e) { fail('journal', e); }
      }
      let journaled = report.errors.length === 0;
      if (journaled) {
        try {
          const { journal = [] } = await api.storage.local.get('journal');
          journal.push(entry);
          await api.storage.local.set({ journal: journal.slice(-journalLimit) });
          report.journaled = entry;
        } catch (e) { fail('journal', e); journaled = false; }
      }
      if (!journaled) {
        report.skippedDeletes = true;
      } else {
        for (const a of closes) await step(`close ${a.title || a.url}`, () => api.tabs.remove(idOf(a.key)));
        for (const a of deletes) {
          await step(`delete ${a.title}`, () => (a.kind === 'delete-folder' ? api.bookmarks.removeTree(idOf(a.key)) : api.bookmarks.remove(idOf(a.key))));
        }
      }
    }
  }

  // The tabs stay open when the deletes were skipped: those taken out of their group ahead of closing go back into it.
  // They return while the group exists (it ends with its last member), at its edge rather than their old index.
  // tabs.group rejects the whole call on one unknown id, so only the tabs still open are sent.
  if (report.skippedDeletes && ungroupedToClose.size) {
    const open = await readTabs();
    const byGroup = new Map();
    for (const [id, groupId] of ungroupedToClose) if (open.has(id)) byGroup.set(groupId, [...(byGroup.get(groupId) || []), id]);
    for (const [groupId, tabIds] of byGroup) {
      if (await groupExists(groupId)) await step('regroup tabs kept open', () => api.tabs.group({ tabIds, groupId }));
    }
  }
  return report;
}
