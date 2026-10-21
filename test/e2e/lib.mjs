// Shared e2e helpers: the standard seed (the DESIGN.md §2 example as real Chrome state), buffer lookups by page
// name, and a scenario runner that applies an edit and checks the three invariants after every apply.

import assert from 'node:assert/strict';
import { parseText } from '../../src/core/parse.js';
import { nameOfUrl } from './helpers.mjs';

export const STANDARD = {
  windows: [
    ['neovim', 'oil', { group: 'Research', color: 'blue', tabs: ['attention', 'gpt3'] }, 'hn'],
    ['tmux', 'codemirror'],
  ],
  bookmarks: {
    bar: [{ folder: 'Dev', children: [['GitHub', 'github'], ['MDN', 'mdn']] }, { folder: 'Read later', children: [] }],
    other: [['Wikipedia', 'wikipedia']],
  },
};

export const RESEARCH = (...tabs) => ({ group: 'Research', color: 'blue', tabs });

/** Lookups on a rendered buffer: entry lines by page name, folders/groups by title, windows by ordinal. */
export function keysOf(text) {
  const { lines } = parseText(text);
  const key = (L) => `${L.anchor.kind}${L.anchor.id}`;
  const byName = new Map();
  const byTitle = new Map();
  const wins = [];
  for (const L of lines) {
    if (L.type === 'entry' && L.url) byName.set(nameOfUrl(L.url), key(L));
    if (L.type === 'folder') {
      byTitle.set(L.name.replace(/ \[\w+\]$/, ''), key(L));
      if (L.anchor.kind === 'w') wins.push(key(L));
    }
  }
  const K = (name) => { const k = byName.get(name); if (!k) throw new Error(`no entry for ${name}`); return k; };
  K.title = (t) => { const k = byTitle.get(t); if (!k) throw new Error(`no folder/group titled ${t}`); return k; };
  K.win = (n) => wins[n - 1];
  return K;
}

/**
 * Render, edit, apply, and check: (a) final Chrome state === `expected`, (b) no errors / mismatches / refusal,
 * (c) re-rendering the result plans to nothing.
 */
export async function scenario(h, { edit, expected, warnings, allowErrors = false }) {
  const { text, snapshot } = await h.render();
  const K = keysOf(text);
  const edited = typeof edit === 'function' ? await edit(text, K, h) : edit; // may change Chrome between render and apply
  const { plan, report } = await h.applyText(snapshot, edited);
  if (!allowErrors) {
    assert.deepEqual(plan.errors, [], 'plan errors');
    assert.deepEqual(report.errors, [], 'apply errors');
    assert.equal(report.refused, false, 'refused');
    assert.deepEqual(report.mismatches, [], 'verification mismatches');
  }
  if (warnings) assert.deepEqual(plan.warnings.map((w) => w.message), warnings, 'warnings');
  if (expected) assert.deepEqual(await h.settledState(), expected, 'final chrome state');
  const again = await h.render();
  const p2 = await h.planText(again.snapshot, again.text);
  assert.deepEqual([p2.actions, p2.errors, p2.warnings], [[], [], []], 're-render → plan must be empty');
  return { plan, report, before: { text, snapshot }, after: again };
}
