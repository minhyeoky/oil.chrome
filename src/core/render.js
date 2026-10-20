// snapshot → { text, lines }  (DESIGN.md §2). Pure: no chrome APIs.
//
// `lines[i]` describes text line i (blank separator lines included):
//   { kind: 'window'|'group'|'tab'|'root'|'folder'|'bookmark'|'blank', key, indent, text, ... }

import { anchorText, entryContent, folderContent, groupContent } from './grammar.js';
import { indexSnapshot, windowItems } from './model.js';

const INDENT = 2;

export function render(snapshot) {
  const ix = indexSnapshot(snapshot);
  const blocks = [];

  const line = (kind, key, depth, content, extra = {}) => ({
    kind, key, indent: depth * INDENT,
    text: ' '.repeat(depth * INDENT) + anchorText(key[0], key.slice(1)) + content,
    ...extra,
  });
  const tabLine = (tk, depth) => {
    const t = ix.tabs.get(tk);
    return line('tab', tk, depth, entryContent(t.title, t.url), { url: t.url, pinned: t.pinned, active: t.active });
  };

  for (const wk of ix.windowKeys) {
    const w = ix.windows.get(wk);
    const out = [line('window', wk, 0, folderContent(`Window ${w.ordinal}`), { focused: w.focused })];
    for (const item of windowItems(ix, wk)) {
      if (item.type === 'tab') { out.push(tabLine(item.key, 1)); continue; }
      const g = ix.groups.get(item.key);
      out.push(line('group', item.key, 1, groupContent(g.title, g.color), { color: g.color }));
      for (const tk of item.members) out.push(tabLine(tk, 2));
    }
    blocks.push(out);
  }

  const folder = (key, depth, out) => {
    const n = ix.bm.get(key);
    out.push(line(n.isRoot ? 'root' : 'folder', key, depth, folderContent(n.title)));
    for (const ck of n.childKeys) {
      const c = ix.bm.get(ck);
      if (c.isFolder) folder(ck, depth + 1, out);
      else out.push(line('bookmark', ck, depth + 1, entryContent(c.title, c.url), { url: c.url }));
    }
  };
  for (const rk of ix.rootKeys) {
    const out = [];
    folder(rk, 0, out);
    blocks.push(out);
  }

  const lines = [];
  blocks.forEach((b, i) => {
    if (i > 0) lines.push({ kind: 'blank', key: null, indent: 0, text: '' });
    lines.push(...b);
  });
  return { text: lines.map((l) => l.text).join('\n'), lines };
}
