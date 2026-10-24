// text → line tree (DESIGN.md §2 "부모"). Pure: no chrome APIs.
//
// Parent = the nearest preceding *folder* line with a smaller indent (entry lines can never be parents).
// Kept as a monotonic stack: a folder pops every stack entry whose indent is >= its own, because such an
// entry can never again be "the nearest preceding folder with smaller indent" for any later line.

import { parseLine } from './grammar.js';

/**
 * `opts.isFolderKey(key)` tells whether an anchor names a folder, which keeps its line a folder once its `/` is gone
 * (see parseLine); without it that holds for `w` and `g` anchors.
 * @returns {{ lines: Array<{ n:number, idx:number, raw:string, indent:number, anchor:object|null, type:string,
 *   name?:string, title?:string, url?:string|null, content:string, parent:number, children:number[] }> }}
 *   `n` is the 0-based text line number, `idx` the position in `lines` (blank lines are skipped).
 */
export function parseText(text, opts) {
  const lines = [];
  const stack = [];
  String(text).split('\n').forEach((raw, n) => {
    const p = parseLine(raw, opts);
    if (!p) return;
    const L = { n, idx: lines.length, raw, ...p, parent: -1, children: [] };
    for (let i = stack.length - 1; i >= 0; i--) {
      if (lines[stack[i]].indent < L.indent) { L.parent = stack[i]; break; }
    }
    if (L.parent >= 0) lines[L.parent].children.push(L.idx);
    if (L.type === 'folder') {
      while (stack.length && lines[stack[stack.length - 1]].indent >= L.indent) stack.pop();
      stack.push(L.idx);
    }
    lines.push(L);
  });
  return { lines };
}
