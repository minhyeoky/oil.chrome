// plan(S, F, text) → { actions, desired, errors, warnings, marks, roles }  (DESIGN.md §3–§5). Pure: no chrome APIs.
//
//  S = snapshot the buffer was rendered from (content comparisons use S)
//  F = fresh snapshot (position comparisons use F)
//
// Entity keys: existing `w12` `t12` `g5` `b11`; entities the plan creates get `n1`, `n2`, … in document order.

import { bareHostUrl, splitGroupName } from './grammar.js';
import { countBookmarks, indexSnapshot, windowItems } from './model.js';
import { parseText } from './parse.js';

const entityOf = (ix, key) => {
  switch (key[0]) {
    case 'w': return ix.windows.get(key);
    case 't': return ix.tabs.get(key);
    case 'g': return ix.groups.get(key);
    case 'b': return ix.bm.get(key);
    default: return undefined;
  }
};

const sameArray = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Role of every parsed line, from its position (DESIGN.md §3): window | group | tab | broot | bfolder | bookmark |
 * invalid. Sets `L.akey` and `L.role`; `report(L, message)` is called for each structural error.
 */
export function assignRoles(lines, rootSet, report = () => {}) {
  for (const L of lines) {
    const P = L.parent >= 0 ? lines[L.parent] : null;
    const isFolder = L.type === 'folder';
    L.akey = L.anchor ? L.anchor.kind + L.anchor.id : null;
    if (!P) {
      if (isFolder) L.role = L.akey && L.anchor.kind === 'b' && rootSet.has(L.akey) ? 'broot' : 'window';
      else { L.role = 'invalid'; report(L, 'top-level entry — put it under a window or a bookmark folder'); }
    } else if (P.role === 'window') {
      L.role = isFolder ? 'group' : 'tab';
    } else if (P.role === 'group') {
      if (isFolder) { L.role = 'invalid'; report(L, 'groups cannot nest'); } else L.role = 'tab';
    } else if (P.role === 'broot' || P.role === 'bfolder') {
      L.role = isFolder ? 'bfolder' : 'bookmark';
    } else {
      L.role = 'invalid'; // inside an invalid subtree: already reported on the ancestor
    }
  }
}

export function plan(baseSnapshot, freshSnapshot, text) {
  const S = indexSnapshot(baseSnapshot);
  const F = indexSnapshot(freshSnapshot);
  const { lines } = parseText(text);

  const errors = [];
  const warnings = [];
  const marks = [];
  const err = (L, message) => {
    errors.push({ line: L ? L.n : -1, message });
    if (L) marks.push({ line: L.n, kind: 'error', text: `✗ ${message}` });
  };
  const warn = (L, message) => {
    warnings.push({ line: L.n, message });
    marks.push({ line: L.n, kind: 'warn', text: `⚠ ${message}` });
  };
  const mark = (L, kind, text) => marks.push({ line: L.n, kind, text });

  // ───────────────────────── roles (DESIGN §3) ─────────────────────────
  const rootSet = new Set([...S.rootKeys, ...F.rootKeys]);
  assignRoles(lines, rootSet, err);

  // ───────────────────────── identity (DESIGN §4) ─────────────────────────
  const candidateKey = (L) => {
    const k = L.akey;
    if (!k || L.role === 'invalid') return null;
    switch (L.role) {
      case 'window': return k[0] === 'w' && S.windows.has(k) ? k : null;
      case 'group': return k[0] === 'g' && S.groups.has(k) ? k : null;
      case 'tab': return k[0] === 't' && S.tabs.has(k) ? k : null;
      case 'broot': return k[0] === 'b' && S.rootKeys.includes(k) ? k : null;
      case 'bfolder': { const r = k[0] === 'b' && S.bm.get(k); return r && r.isFolder && !r.isRoot ? k : null; }
      case 'bookmark': { const r = k[0] === 'b' && S.bm.get(k); return r && !r.isFolder ? k : null; }
      default: return null;
    }
  };
  const baseParentKey = (k) => {
    switch (k[0]) {
      case 't': { const t = S.tabs.get(k); return t.groupKey ?? t.windowKey; }
      case 'g': return S.groups.get(k).windowKey;
      case 'b': return S.bm.get(k).parentKey ?? 'TOP';
      default: return 'TOP';
    }
  };

  const cands = new Map();
  for (const L of lines) {
    L.ckey = candidateKey(L);
    L.ekey = null;
    L.copyOf = null;
    L.srcKey = null;
    if (L.anchor && L.role !== 'invalid' && !entityOf(S, L.akey)) {
      warn(L, `unknown anchor /${L.akey} — treated as new`);
    }
    if (L.ckey) {
      if (!cands.has(L.ckey)) cands.set(L.ckey, []);
      cands.get(L.ckey).push(L);
    }
  }
  // The original is the first candidate whose parent line is the original of the base parent
  // (an exact copy of a block duplicates the anchors of its parents too); else the first whose parent
  // anchor equals the base parent; else the first in document order. The rest are copies.
  const resolved = new Map();
  const resolve = (k) => {
    if (resolved.has(k)) return resolved.get(k);
    resolved.set(k, null); // cycle guard
    const ls = cands.get(k);
    const base = baseParentKey(k);
    const parentOf = (L) => (L.parent >= 0 ? lines[L.parent] : null);
    let pick = ls.find((L) => {
      const P = parentOf(L);
      return P && P.ckey && P.ckey === base && resolve(base) === P;
    });
    if (!pick) pick = ls.find((L) => (parentOf(L) ? parentOf(L).akey : 'TOP') === base);
    pick ??= ls[0];
    resolved.set(k, pick);
    return pick;
  };
  for (const k of cands.keys()) resolve(k);
  for (const [k, ls] of cands) {
    const orig = resolved.get(k);
    for (const L of ls) {
      if (L === orig) L.ekey = k;
      else L.copyOf = k;
    }
  }
  let nn = 0;
  const inF = (k) => !!entityOf(F, k);
  for (const L of lines) {
    if (L.role === 'invalid') continue;
    L.srcKey = L.copyOf ?? (!L.ekey && L.akey && entityOf(S, L.akey) ? L.akey : null);
    L.key = L.ekey ?? `n${++nn}`;
    L.gone = !!L.ekey && !inF(L.ekey);
    if (L.gone) warn(L, 'gone — skipped');
  }
  // a line whose desired parent vanished outside cannot be applied
  for (const L of lines) {
    if (L.role === 'invalid' || L.gone || L.parent < 0) continue;
    if (lines[L.parent].gone) err(L, 'parent was closed outside — :e! to reload');
  }
  for (const k of S.rootKeys) {
    if (!cands.has(k)) err(null, `bookmark root "${S.bm.get(k).title}" cannot be deleted or moved`);
  }

  // ───────────────────────── naming helpers (labels only) ─────────────────────────
  const live = (k) => entityOf(F, k) ?? entityOf(S, k);
  const winName = (k) => {
    if (k[0] === 'n') return 'new window';
    const w = live(k);
    return w ? `Window ${w.ordinal}` : k;
  };
  const groupInfo = new Map(); // key → { title, color }
  const groupName = (k) => {
    const g = groupInfo.get(k) ?? live(k);
    return g && g.title ? g.title : g ? `(${g.color || 'untitled'})` : k;
  };
  const newFolders = new Map(); // key → { title, parent }
  const bmPath = (k) => {
    const parts = [];
    for (let cur = k; cur;) {
      if (cur[0] === 'n') { const nf = newFolders.get(cur); if (!nf) break; parts.unshift(nf.title); cur = nf.parent; continue; }
      const r = live(cur);
      if (!r) break;
      parts.unshift(r.title);
      cur = r.parentKey;
    }
    return parts.join('/');
  };
  const tabTitle = (k) => { const t = live(k); return t ? t.title || t.url : k; };
  const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  // ───────────────────────── buckets ─────────────────────────
  const A = {
    newWindow: [], newTab: [], newGroup: [], newBm: [],
    moveGroup: [], moveTab: [], moveBm: [], reorder: [],
    update: [], close: [], del: [], removeGroup: [],
  };
  const desired = { windows: [], groups: {}, folders: [] };

  // ───────────────────────── tabs domain ─────────────────────────
  const srcType = (k) => (!k ? null : k[0] === 't' ? 'tab' : k[0] === 'b' ? (S.bm.get(k)?.isFolder ? 'folder' : 'bookmark') : k[0] === 'w' ? 'window' : 'group');

  const makeTab = (C) => {
    const rec = { key: C.key, line: C, isNew: !C.ekey, copy: !!C.copyOf, source: srcType(C.srcKey), srcKey: C.srcKey, pinned: false, url: null, windowKey: null, groupKey: null };
    if (!rec.isNew) {
      rec.pinned = F.tabs.get(rec.key).pinned;
      const t = S.tabs.get(rec.key);
      if (C.type === 'entry') {
        if (C.url && C.url !== t.url) {
          A.update.push({ kind: 'navigate-tab', key: rec.key, line: C.n, from: t.url, to: C.url, label: `↻ tab ${short(t.title || t.url)} → ${C.url}` });
          mark(C, 'navigate', '↻ navigate');
        }
        if (C.title !== t.title) warn(C, 'title is read-only');
      }
      return rec;
    }
    let url = C.url || bareHostUrl(C);
    if (!url && C.srcKey) url = entityOf(S, C.srcKey)?.url || null;
    if (!url) { err(C, `cannot read a URL from "${short(C.content, 30)}"`); return null; }
    rec.url = url;
    return rec;
  };
  const makeGroup = (C) => {
    const { title, color } = splitGroupName(C.name);
    const rec = { key: C.key, line: C, isNew: !C.ekey, title, color, changes: {} };
    if (rec.isNew) {
      rec.color = color; // may be null → Chrome picks
    } else {
      const g = S.groups.get(C.key);
      if (title !== g.title) rec.changes.title = title;
      if (color && color !== g.color) rec.changes.color = color;
    }
    return rec;
  };

  const wins = [];
  for (const W of lines) {
    if (W.role !== 'window' || W.gone) continue;
    const win = { key: W.key, isNew: !W.ekey, line: W, items: [] };
    for (const ci of W.children) {
      const C = lines[ci];
      if (C.gone || C.role === 'invalid') continue;
      if (C.role === 'tab') {
        const r = makeTab(C);
        if (r) win.items.push({ type: 'tab', rec: r });
      } else if (C.role === 'group') {
        const g = makeGroup(C);
        const members = [];
        for (const mi of C.children) {
          const M = lines[mi];
          if (M.gone || M.role !== 'tab') continue;
          const r = makeTab(M);
          if (r) members.push(r);
        }
        win.items.push({ type: 'group', rec: g, members });
      }
    }
    wins.push(win);
  }

  const isPinnedTab = (it) => it.type === 'tab' && it.rec.pinned;
  for (const win of wins) {
    const items = [];
    for (const it of win.items) {
      if (it.type === 'tab') { items.push(it); continue; }
      const keep = [];
      for (const m of it.members) {
        if (m.pinned) { warn(m.line, "pinned tabs can't be grouped"); items.push({ type: 'tab', rec: m }); } else keep.push(m);
      }
      it.members = keep;
      if (keep.length === 0) { warn(it.rec.line, 'empty group — ignored'); continue; }
      items.push(it);
    }
    let seenUnpinned = false;
    for (const it of items) {
      if (isPinnedTab(it)) { if (seenUnpinned) warn(it.rec.line, 'pinned tabs stay first'); } else seenUnpinned = true;
    }
    win.eff = [...items.filter(isPinnedTab), ...items.filter((it) => !isPinnedTab(it))];
  }

  const firstTab = (eff) => {
    for (const it of eff) return it.type === 'tab' ? it.rec : it.members[0];
    return null;
  };

  for (const win of wins) {
    if (win.isNew && win.eff.length === 0) { warn(win.line, 'new window has no tabs — skipped'); win.skip = true; continue; }
    if (win.isNew) {
      const ft = firstTab(win.eff);
      A.newWindow.push({ kind: 'new-window', key: win.key, line: win.line.n, first: ft.key, label: '+ window' });
      mark(win.line, 'new', win.line.copyOf ? '⧉ copy' : '+ new');
    }
    for (const it of win.eff) {
      const members = it.type === 'tab' ? [it.rec] : it.members;
      const gRec = it.type === 'group' ? it.rec : null;
      const gKey = gRec ? gRec.key : null;
      if (gRec) {
        groupInfo.set(gRec.key, { title: gRec.title, color: gRec.color });
        desired.groups[gRec.key] = { key: gRec.key, isNew: gRec.isNew, title: gRec.title, color: gRec.color, windowKey: win.key };
      }
      const groupWindowChanged = gRec && !gRec.isNew && (win.isNew || F.groups.get(gRec.key).windowKey !== win.key);
      if (gRec && !gRec.isNew) {
        if (groupWindowChanged) {
          A.moveGroup.push({ kind: 'move-group', key: gRec.key, line: gRec.line.n, window: win.key, label: `→ group ${groupName(gRec.key)} → ${winName(win.key)}` });
          mark(gRec.line, 'move', `→ ${winName(win.key)}`);
        }
        if (Object.keys(gRec.changes).length) {
          const bits = Object.entries(gRec.changes).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ');
          A.update.push({ kind: 'edit-group', key: gRec.key, line: gRec.line.n, changes: gRec.changes, label: `✎ group ${groupName(gRec.key)}: ${bits}` });
          mark(gRec.line, 'edit', '✎ edit');
        }
      }
      if (gRec && gRec.isNew) {
        A.newGroup.push({
          kind: 'new-group', key: gRec.key, line: gRec.line.n, title: gRec.title, color: gRec.color, window: win.key,
          members: members.map((m) => m.key),
          label: `+ group ${gRec.title || '(untitled)'}${gRec.color ? ` [${gRec.color}]` : ''}`,
        });
        mark(gRec.line, 'new', gRec.line.copyOf ? '⧉ copy' : '+ new');
      }
      for (const r of members) {
        r.windowKey = win.key;
        r.groupKey = gKey;
        if (r.isNew) {
          const label = r.source === 'bookmark'
            ? `↗ tab ${short(r.url)} (from bookmark) → ${winName(win.key)}`
            : `+ tab ${short(r.url)} → ${winName(win.key)}${gRec ? `/${groupName(gKey)}` : ''}`;
          A.newTab.push({ kind: 'new-tab', key: r.key, line: r.line.n, url: r.url, window: win.key, group: gKey, source: r.source ? { type: r.source, key: r.srcKey } : null, copy: r.copy, label });
          if (r.source === 'bookmark') mark(r.line, 'open', '↗ open');
          else if (r.copy) mark(r.line, 'copy', '⧉ copy');
          else mark(r.line, 'new', '+ new');
          continue;
        }
        const f = F.tabs.get(r.key);
        const winChanged = win.isNew || f.windowKey !== win.key;
        const grpChanged = (f.groupKey ?? null) !== gKey;
        if (gKey && gRec.isNew) mark(r.line, 'move', `→ [${groupName(gKey)}]`);
        const carried = gRec && !gRec.isNew && f.groupKey === gKey && groupWindowChanged;
        if (carried) continue;
        if (winChanged || (grpChanged && !(gRec && gRec.isNew))) {
          const dest = winChanged ? winName(win.key) : gKey ? `[${groupName(gKey)}]` : winName(win.key);
          const where = gKey && winChanged ? `${winName(win.key)}/${groupName(gKey)}` : dest;
          A.moveTab.push({
            kind: 'move-tab', key: r.key, line: r.line.n, window: win.key, group: gKey,
            fromWindow: f.windowKey, fromGroup: f.groupKey ?? null,
            label: `→ tab ${short(tabTitle(r.key))} → ${where}`,
          });
          if (!(gKey && gRec.isNew)) mark(r.line, 'move', gKey && !winChanged ? `→ [${groupName(gKey)}]` : `→ ${winName(win.key)}`);
        }
      }
    }

    // reorder (stayers = items whose window and group do not change; they are compared on F)
    if (!win.isNew) {
      const stay = new Map();
      for (const it of win.eff) {
        if (it.type === 'tab') {
          if (!it.rec.isNew) {
            const f = F.tabs.get(it.rec.key);
            if (f.windowKey === win.key && f.groupKey === null) stay.set(it.rec.key, true);
          }
        } else if (!it.rec.isNew && F.groups.get(it.rec.key)?.windowKey === win.key) {
          stay.set(it.rec.key, true);
        }
      }
      const want = win.eff.map((it) => it.rec.key).filter((k) => stay.has(k));
      const have = windowItems(F, win.key).map((it) => it.key).filter((k) => stay.has(k));
      if (!sameArray(want, have)) {
        A.reorder.push({ kind: 'reorder', parent: win.key, count: win.eff.length, label: `↕ ${winName(win.key)} (${win.eff.length})` });
      }
    }
    for (const it of win.eff) {
      if (it.type !== 'group' || it.rec.isNew || !F.groups.has(it.rec.key)) continue;
      const g = F.groups.get(it.rec.key);
      const inGroup = new Set(it.members.filter((m) => !m.isNew && g.tabKeys.includes(m.key)).map((m) => m.key));
      const want = it.members.map((m) => m.key).filter((k) => inGroup.has(k));
      const have = g.tabKeys.filter((k) => inGroup.has(k));
      if (!sameArray(want, have)) {
        A.reorder.push({ kind: 'reorder', parent: g.key, count: it.members.length, label: `↕ ${groupName(g.key)} (${it.members.length})` });
      }
    }

    desired.windows.push({
      key: win.key, isNew: win.isNew,
      items: win.eff.map((it) => (it.type === 'tab'
        ? { type: 'tab', key: it.rec.key, pinned: it.rec.pinned }
        : { type: 'group', key: it.rec.key, members: it.members.map((m) => m.key) })),
    });
  }

  // removals in the tabs domain
  for (const [k, t] of S.tabs) {
    if (cands.has(k) || !inF(k)) continue;
    A.close.push({ kind: 'close-tab', key: k, title: t.title, url: t.url, label: `✕ tab ${short(t.title || t.url)}` });
  }
  for (const [k, g] of S.groups) {
    if (cands.has(k) || !inF(k)) continue;
    A.removeGroup.push({ kind: 'remove-group', key: k, title: g.title, label: `✕ group ${g.title || `(${g.color})`} (ungroup)` });
  }

  // ───────────────────────── bookmarks domain ─────────────────────────
  const makeBookmark = (C) => {
    const rec = { key: C.key, line: C, isNew: !C.ekey, copy: !!C.copyOf, source: srcType(C.srcKey), srcKey: C.srcKey, isFolder: false };
    if (!rec.isNew) {
      const b = S.bm.get(rec.key);
      const changes = {};
      const newTitle = C.type === 'empty' ? '' : C.title;
      if (newTitle !== b.title) changes.title = newTitle;
      if (C.type === 'entry' && C.url && C.url !== b.url) changes.url = C.url;
      if (Object.keys(changes).length) {
        const bits = Object.entries(changes).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ');
        A.update.push({ kind: 'edit-bookmark', key: rec.key, line: C.n, changes, label: `✎ bookmark ${short(b.title || b.url)}: ${bits}` });
        mark(C, 'edit', '✎ edit');
      }
      return rec;
    }
    const src = C.srcKey ? entityOf(S, C.srcKey) : null;
    rec.url = C.url || (src && src.url) || null;
    rec.title = C.title || (src && src.title) || '';
    if (!rec.url) { err(C, 'a bookmark needs a URL'); return null; }
    return rec;
  };

  const folderRecs = new Map();
  for (const R of lines) {
    if ((R.role !== 'broot' && R.role !== 'bfolder') || R.gone) continue;
    if (R.role === 'broot' && R.copyOf) { err(R, 'duplicate bookmark root'); continue; }
    const rec = { key: R.key, line: R, isNew: !R.ekey, copy: !!R.copyOf, source: srcType(R.srcKey), srcKey: R.srcKey, isFolder: true, title: R.name, isRoot: R.role === 'broot', children: [] };
    rec.parentKey = R.parent >= 0 ? lines[R.parent].key : null;
    folderRecs.set(R.key, rec);
    if (rec.isNew) newFolders.set(R.key, { title: rec.title, parent: rec.parentKey });
    else if (!rec.isRoot && R.name !== S.bm.get(R.key).title) {
      A.update.push({ kind: 'edit-folder', key: R.key, line: R.n, changes: { title: R.name }, label: `✎ folder ${short(S.bm.get(R.key).title)}: title ${JSON.stringify(R.name)}` });
      mark(R, 'edit', '✎ edit');
    }
  }
  const bmRecs = new Map();
  for (const R of lines) {
    if (R.role !== 'bookmark' || R.gone || R.parent < 0 || !folderRecs.has(lines[R.parent].key)) continue;
    const rec = makeBookmark(R);
    if (rec) bmRecs.set(R.key, rec);
  }
  for (const frec of folderRecs.values()) {
    for (const ci of frec.line.children) {
      const C = lines[ci];
      if (C.gone || C.role === 'invalid') continue;
      const rec = C.role === 'bookmark' ? bmRecs.get(C.key) : C.role === 'bfolder' ? folderRecs.get(C.key) : null;
      if (rec) frec.children.push(rec);
    }
  }

  for (const frec of folderRecs.values()) {
    if (frec.isNew) {
      const parentPath = bmPath(frec.parentKey);
      A.newBm.push({
        kind: 'new-folder', key: frec.key, line: frec.line.n, title: frec.title, parent: frec.parentKey,
        label: `+ folder ${short(frec.title || '(untitled)')} → ${parentPath}`,
      });
      mark(frec.line, 'new', frec.copy ? '⧉ copy' : '+ new');
    }
    for (const r of frec.children) {
      if (r.isNew && !r.isFolder) {
        const fromTab = r.source === 'tab';
        A.newBm.push({
          kind: 'new-bookmark', key: r.key, line: r.line.n, title: r.title, url: r.url, parent: frec.key,
          source: r.source ? { type: r.source, key: r.srcKey } : null, copy: r.copy,
          label: fromTab ? `★ bookmark ${short(r.title || r.url)} (from tab) → ${bmPath(frec.key)}` : `+ bookmark ${short(r.title || r.url)} → ${bmPath(frec.key)}`,
        });
        if (fromTab) mark(r.line, 'bookmark', '★ bookmark');
        else if (r.copy) mark(r.line, 'copy', '⧉ copy');
        else mark(r.line, 'new', '+ new');
        continue;
      }
      if (r.isNew) continue; // new folder: handled in its own iteration
      const f = F.bm.get(r.key);
      if (f.parentKey !== frec.key) {
        A.moveBm.push({
          kind: r.isFolder ? 'move-folder' : 'move-bookmark', key: r.key, line: r.line.n, parent: frec.key, fromParent: f.parentKey,
          label: `→ ${short(f.title || f.url || '(untitled)')} → ${bmPath(frec.key)}`,
        });
        mark(r.line, 'move', `→ ${frec.title || bmPath(frec.key)}`);
      }
    }
    if (!frec.isNew && F.bm.has(frec.key)) {
      const stay = new Set(frec.children.filter((r) => !r.isNew && F.bm.get(r.key).parentKey === frec.key).map((r) => r.key));
      const want = frec.children.map((r) => r.key).filter((k) => stay.has(k));
      const have = F.bm.get(frec.key).childKeys.filter((k) => stay.has(k));
      if (!sameArray(want, have)) {
        A.reorder.push({ kind: 'reorder', parent: frec.key, count: frec.children.length, label: `↕ ${bmPath(frec.key)} (${frec.children.length})` });
      }
    }
    desired.folders.push({ key: frec.key, isNew: frec.isNew, children: frec.children.map((r) => r.key) });
  }

  // deletions in the bookmarks domain: only the outermost deleted folder is listed
  const deleted = new Set();
  for (const [k, b] of S.bm) {
    if (b.isRoot || cands.has(k) || !inF(k)) continue;
    deleted.add(k);
  }
  for (const k of deleted) {
    const b = S.bm.get(k);
    if (b.parentKey && deleted.has(b.parentKey)) continue; // subsumed by the ancestor
    if (!b.isFolder) {
      A.del.push({ kind: 'delete-bookmark', key: k, title: b.title, url: b.url, label: `✕ bookmark ${short(b.title || b.url)}` });
      continue;
    }
    const gone = [];
    const walk = (fk) => { for (const ck of S.bm.get(fk).childKeys) { gone.push(ck); if (S.bm.get(ck).isFolder) walk(ck); } };
    walk(k);
    const count = gone.filter((ck) => !S.bm.get(ck).isFolder && deleted.has(ck)).length;
    // bookmarks added outside while editing would be wiped by removeTree
    const fWalk = (fk) => (F.bm.get(fk)?.childKeys ?? []).some((ck) => !S.bm.has(ck) || (F.bm.get(ck).isFolder && fWalk(ck)));
    if (fWalk(k)) err(null, `folder "${b.title}" got new contents outside — :e! to reload`);
    A.del.push({ kind: 'delete-folder', key: k, title: b.title, count, label: `✕ folder ${short(b.title || '(untitled)')} (${count} bookmark${count === 1 ? '' : 's'})` });
  }

  const actions = [
    ...A.newWindow, ...A.newTab, ...A.newGroup, ...A.newBm,
    ...A.moveGroup, ...A.moveTab, ...A.moveBm, ...A.reorder,
    ...A.update,
    ...A.close, ...A.del, ...A.removeGroup,
  ];
  marks.sort((a, b) => a.line - b.line);
  // per non-blank line: the role its position gives it (window group tab broot bfolder bookmark invalid), for the editor
  const roles = lines.map((L) => ({ n: L.n, role: L.role, key: L.key ?? null, anchor: L.akey }));
  return { actions, desired, errors, warnings, marks, roles };
}

/** Counts for the status bar: `+2 →3 ↕1 ↻1 ✎1 ✕4`. */
export function summarize(actions) {
  const s = { add: 0, move: 0, reorder: 0, navigate: 0, edit: 0, remove: 0 };
  for (const a of actions) {
    if (a.kind.startsWith('new-')) s.add++;
    else if (a.kind.startsWith('move-')) s.move++;
    else if (a.kind === 'reorder') s.reorder++;
    else if (a.kind === 'navigate-tab') s.navigate++;
    else if (a.kind.startsWith('edit-')) s.edit++;
    else if (a.kind === 'close-tab' || a.kind.startsWith('delete-')) s.remove++;
  }
  return s;
}

export function summaryText(actions) {
  const s = summarize(actions);
  return [
    s.add && `+${s.add}`, s.move && `→${s.move}`, s.reorder && `↕${s.reorder}`,
    s.navigate && `↻${s.navigate}`, s.edit && `✎${s.edit}`, s.remove && `✕${s.remove}`,
  ].filter(Boolean).join(' ');
}
