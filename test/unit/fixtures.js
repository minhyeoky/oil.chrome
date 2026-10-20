// Shared fixtures: the DESIGN.md §2 render example as a snapshot, plus text-editing helpers for the golden cases.

import { render } from '../../src/core/render.js';
import { plan } from '../../src/core/plan.js';

const tab = (id, index, title, url, extra = {}) => ({ id, index, title, url, pinned: false, active: false, groupId: -1, ...extra });

/** The snapshot S behind the DESIGN.md §2 render example. */
export function baseSnapshot() {
  return {
    windows: [
      {
        id: 1, focused: true,
        tabs: [
          tab(11, 0, 'Neovim', 'https://neovim.io/'),
          tab(12, 1, 'oil.nvim', 'https://github.com/stevearc/oil.nvim', { active: true }),
          tab(13, 2, 'Attention', 'https://arxiv.org/abs/1706.03762', { groupId: 5 }),
          tab(14, 3, 'GPT-3', 'https://arxiv.org/abs/2005.14165', { groupId: 5 }),
          tab(15, 4, 'Hacker News', 'https://news.ycombinator.com/'),
        ],
      },
      {
        id: 2, focused: false,
        tabs: [
          tab(21, 0, 'tmux-oil', 'https://github.com/minhyeoky/tmux-oil.nvim', { active: true }),
          tab(22, 1, 'CodeMirror', 'https://codemirror.net/'),
        ],
      },
    ],
    groups: [{ id: 5, windowId: 1, title: 'Research', color: 'blue', collapsed: false }],
    bookmarks: [
      {
        id: '1', title: 'Bookmarks bar',
        children: [
          { id: '10', title: 'Dev', children: [
            { id: '11', title: 'GitHub', url: 'https://github.com/' },
            { id: '12', title: 'MDN', url: 'https://developer.mozilla.org/' },
          ] },
          { id: '13', title: 'Read later', children: [] },
        ],
      },
      { id: '2', title: 'Other bookmarks', children: [{ id: '20', title: 'Wikipedia', url: 'https://www.wikipedia.org/' }] },
      { id: '3', title: 'Mobile bookmarks', children: [] },
    ],
  };
}

/** The literal text of the DESIGN.md §2 render example. */
export const EXAMPLE = `/w1 Window 1/
  /t11 Neovim https://neovim.io/
  /t12 oil.nvim https://github.com/stevearc/oil.nvim
  /g5 Research [blue]/
    /t13 Attention https://arxiv.org/abs/1706.03762
    /t14 GPT-3 https://arxiv.org/abs/2005.14165
  /t15 Hacker News https://news.ycombinator.com/

/w2 Window 2/
  /t21 tmux-oil https://github.com/minhyeoky/tmux-oil.nvim
  /t22 CodeMirror https://codemirror.net/

/b1 Bookmarks bar/
  /b10 Dev/
    /b11 GitHub https://github.com/
    /b12 MDN https://developer.mozilla.org/
  /b13 Read later/

/b2 Other bookmarks/
  /b20 Wikipedia https://www.wikipedia.org/

/b3 Mobile bookmarks/`;

// ── text helpers ────────────────────────────────────────────────────────────
export const linesOf = (text) => text.split('\n');
export const joinLines = (ls) => ls.join('\n');
/** index of the line carrying anchor `/<key> ` */
export function find(text, key) {
  const i = linesOf(text).findIndex((l) => l.trimStart().startsWith(`/${key} `));
  if (i < 0) throw new Error(`no line for ${key}`);
  return i;
}
export const lineOf = (text, key) => linesOf(text)[find(text, key)];
/** delete one line */
export function del(text, key) {
  const ls = linesOf(text); ls.splice(find(text, key), 1); return joinLines(ls);
}
/** delete a line and every following line that is indented deeper (the whole block) */
export function delBlock(text, key) {
  const ls = linesOf(text); const i = find(text, key);
  const ind = ls[i].match(/^ */)[0].length; let j = i + 1;
  while (j < ls.length && ls[j].trim() !== '' && ls[j].match(/^ */)[0].length > ind) j++;
  ls.splice(i, j - i); return joinLines(ls);
}
/** the block (line + deeper lines) as an array */
export function block(text, key) {
  const ls = linesOf(text); const i = find(text, key);
  const ind = ls[i].match(/^ */)[0].length; let j = i + 1;
  while (j < ls.length && ls[j].trim() !== '' && ls[j].match(/^ */)[0].length > ind) j++;
  return ls.slice(i, j);
}
export function reindent(ls, delta) {
  return ls.map((l) => (delta >= 0 ? ' '.repeat(delta) + l : l.slice(-delta)));
}
/** insert lines after the line (or block) of `key` */
export function insertAfter(text, key, newLines, { block: wholeBlock = false } = {}) {
  const ls = linesOf(text); const i = find(text, key);
  let j = i + 1;
  if (wholeBlock) {
    const ind = ls[i].match(/^ */)[0].length;
    while (j < ls.length && ls[j].trim() !== '' && ls[j].match(/^ */)[0].length > ind) j++;
  }
  ls.splice(j, 0, ...newLines); return joinLines(ls);
}
export function insertBefore(text, key, newLines) {
  const ls = linesOf(text); ls.splice(find(text, key), 0, ...newLines); return joinLines(ls);
}
export function replaceLine(text, key, newLine) {
  const ls = linesOf(text); ls[find(text, key)] = newLine; return joinLines(ls);
}
/** move a single line so it directly follows `afterKey`'s line (or block), with a new indent */
export function moveLine(text, key, afterKey, indent, opts = {}) {
  const line = lineOf(text, key).trimStart();
  return insertAfter(del(text, key), afterKey, [' '.repeat(indent) + line], opts);
}

export const S = baseSnapshot();
export const run = (text, { fresh = S, base = S } = {}) => plan(base, fresh, text);
export const kinds = (p) => p.actions.map((a) => a.kind);
export const ofKind = (p, kind) => p.actions.filter((a) => a.kind === kind);
export const renderS = (snap = S) => render(snap).text;
