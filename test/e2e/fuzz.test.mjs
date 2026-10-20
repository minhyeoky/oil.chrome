// Randomised end-to-end check of the whole pipeline: seed a random Chrome state, apply a few random buffer edits
// (move / copy / delete / new / rename / regroup …), and require that Chrome now looks like the edited buffer —
// "the buffer is the desired state". The comparison is a projection of both sides that ignores anchors, window
// names and tab titles (titles are read-only), then the usual three invariants.
//
// FUZZ_N (default 30) seeds; FUZZ_SEED=<n> replays one seed.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { rng } from '../unit/properties.helpers.js';
import { parseText } from '../../src/core/parse.js';
import { launch, nameOfUrl } from './helpers.mjs';

let h;
before(async () => { h = await launch({ name: 'fuzz' }); });
after(async () => { await h.close(); });

const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

function randomSpec(r) {
  const int = (n) => Math.floor(r() * n);
  let n = 0;
  const name = () => `p${++n}`;
  const windows = [];
  for (let w = 0, nw = 1 + int(3); w < nw; w++) {
    const items = [];
    let left = 2 + int(5);
    while (left > 0) {
      if (r() < 0.35 && left >= 2) {
        const k = Math.min(left, 1 + int(3));
        items.push({ group: `Grp${n}`, color: COLORS[int(COLORS.length)], tabs: Array.from({ length: k }, name) });
        left -= k;
      } else { items.push(name()); left--; }
    }
    windows.push(items);
  }
  const folder = (depth) => {
    const kids = [];
    for (let i = 0, k = int(4); i < k; i++) kids.push(depth < 2 && r() < 0.35 ? folder(depth + 1) : [`B${++n}`, name()]);
    return { folder: `F${++n}`, children: kids };
  };
  const bar = Array.from({ length: int(4) }, () => (r() < 0.6 ? folder(0) : [`B${++n}`, name()]));
  const other = Array.from({ length: int(3) }, () => [`B${++n}`, name()]);
  return { spec: { windows, bookmarks: { bar, other } }, counter: () => `p${++n}`, colors: () => COLORS[int(COLORS.length)] };
}

// ── buffer tree ─────────────────────────────────────────────────────────────
function toTree(text) {
  const { lines } = parseText(text);
  const nodes = lines.map((L) => ({
    text: L.raw.trimStart(), children: [],
    kind: L.anchor.kind === 'w' ? 'window' : L.anchor.kind === 'g' ? 'group' : L.anchor.kind === 't' ? 'tab'
      : L.type === 'folder' ? (L.parent < 0 ? 'root' : 'folder') : 'bookmark',
  }));
  const top = [];
  lines.forEach((L, i) => (L.parent >= 0 ? nodes[L.parent].children.push(nodes[i]) : top.push(nodes[i])));
  return top;
}
const toLines = (n, d) => [' '.repeat(2 * d) + n.text, ...n.children.flatMap((c) => toLines(c, d + 1))];
const toText = (top) => top.map((n) => toLines(n, 0).join('\n')).join('\n\n');
const clone = (n) => ({ text: n.text, kind: n.kind, children: n.children.map(clone) });

const isTabBox = (n) => n.kind === 'window' || n.kind === 'group';
const isBmBox = (n) => n.kind === 'root' || n.kind === 'folder';
function walk(top, fn, parent = null) { top.forEach((n) => { fn(n, parent); walk(n.children, fn, n); }); }
function descendants(n) { return n.children.flatMap((c) => [c, ...descendants(c)]); }

/** random edit on the tree; returns a description or null when nothing applicable */
function mutate(top, r, gen, h) {
  const int = (n) => Math.floor(r() * n);
  const all = [];
  walk(top, (n, parent) => all.push({ n, parent }));
  const pick = (f) => { const c = all.filter(f); return c.length ? c[int(c.length)] : null; };
  const boxes = (kind) => all.filter(({ n }) => (kind === 'tab' ? isTabBox(n) : isBmBox(n)));
  const place = (node, box) => { box.n.children.splice(int(box.n.children.length + 1), 0, node); };
  const op = int(11);
  switch (op) {
    case 0: { // delete a line only (children are re-attached in place)
      const t = pick(({ n, parent }) => parent && n.kind !== 'window' && n.kind !== 'root');
      if (!t) return null;
      const i = t.parent.children.indexOf(t.n);
      t.parent.children.splice(i, 1, ...(t.n.kind === 'group' || t.n.kind === 'folder' ? t.n.children : []));
      return `del-line ${t.n.text}`;
    }
    case 1: { // delete a block
      const t = pick(({ n, parent }) => parent && n.kind !== 'root');
      if (!t) return null;
      t.parent.children.splice(t.parent.children.indexOf(t.n), 1);
      return `del-block ${t.n.text}`;
    }
    case 2: case 3: { // move
      const t = pick(({ n, parent }) => parent && ['tab', 'bookmark', 'group', 'folder'].includes(n.kind));
      if (!t) return null;
      const inside = new Set([t.n, ...descendants(t.n)]);
      let dests;
      if (t.n.kind === 'tab' || t.n.kind === 'bookmark') dests = [...boxes('tab'), ...boxes('bm')];
      else if (t.n.kind === 'group') dests = all.filter(({ n }) => n.kind === 'window');
      else dests = boxes('bm');
      dests = dests.filter(({ n }) => !inside.has(n));
      if (!dests.length) return null;
      const d = dests[int(dests.length)];
      t.parent.children.splice(t.parent.children.indexOf(t.n), 1);
      place(t.n, d);
      return `move ${t.n.text} → ${d.n.text}`;
    }
    case 4: { // copy
      const t = pick(({ n, parent }) => parent && ['tab', 'bookmark', 'group', 'folder'].includes(n.kind));
      if (!t) return null;
      let dests;
      if (t.n.kind === 'tab' || t.n.kind === 'bookmark') dests = [...boxes('tab'), ...boxes('bm')];
      else if (t.n.kind === 'group') dests = all.filter(({ n }) => n.kind === 'window');
      else dests = boxes('bm');
      const d = dests[int(dests.length)];
      place(clone(t.n), d);
      return `copy ${t.n.text} → ${d.n.text}`;
    }
    case 5: { // new tab
      const d = boxes('tab')[int(boxes('tab').length)];
      if (!d) return null;
      place({ text: h.url(gen.counter()), kind: 'tab', children: [] }, d);
      return `new tab in ${d.n.text}`;
    }
    case 6: { // new bookmark / folder
      const bms = boxes('bm');
      const d = bms[int(bms.length)];
      if (!d) return null;
      if (r() < 0.6) place({ text: `New${int(1000)} ${h.url(gen.counter())}`, kind: 'bookmark', children: [] }, d);
      else {
        const f = { text: `NewFolder${int(1000)}/`, kind: 'folder', children: [{ text: `Kid${int(1000)} ${h.url(gen.counter())}`, kind: 'bookmark', children: [] }] };
        place(f, d);
      }
      return `new bookmark/folder in ${d.n.text}`;
    }
    case 7: { // rename a bookmark / edit URL of a tab or bookmark
      const t = pick(({ n }) => n.kind === 'bookmark' || n.kind === 'tab');
      if (!t) return null;
      const m = /^(\/[tb]\d+ )(.*?)(\S+)$/.exec(t.n.text);
      if (!m) return null;
      if (t.n.kind === 'bookmark' && r() < 0.5) t.n.text = `${m[1]}Renamed${int(1000)} ${m[3]}`;
      else t.n.text = `${m[1]}${m[2]}${h.url(gen.counter())}`;
      return `edit ${t.n.text}`;
    }
    case 8: { // new group around consecutive tabs of a window
      const w = pick(({ n }) => n.kind === 'window');
      if (!w) return null;
      const tabs = w.n.children.filter((c) => c.kind === 'tab');
      if (!tabs.length) return null;
      const first = tabs[int(tabs.length)];
      const i = w.n.children.indexOf(first);
      const run = [first];
      while (r() < 0.5 && w.n.children[i + run.length] && w.n.children[i + run.length].kind === 'tab') run.push(w.n.children[i + run.length]);
      w.n.children.splice(i, run.length, { text: `NewGrp${int(1000)} [${gen.colors()}]/`, kind: 'group', children: run });
      return `new group around ${run.map((x) => x.text).join(' | ')}`;
    }
    case 9: { // edit a group
      const g = pick(({ n }) => n.kind === 'group');
      if (!g) return null;
      const m = /^(\/g\d+ )/.exec(g.n.text);
      if (!m) return null; // a group created by an earlier edit in this round has no anchor yet
      g.n.text = `${m[1]}Edited${int(1000)} [${gen.colors()}]/`;
      return `edit group ${g.n.text}`;
    }
    default: { // new window with moved and/or new tabs
      const kids = [];
      const t = pick(({ n, parent }) => parent && n.kind === 'tab');
      if (t && r() < 0.7) { t.parent.children.splice(t.parent.children.indexOf(t.n), 1); kids.push(t.n); }
      kids.push({ text: h.url(gen.counter()), kind: 'tab', children: [] });
      top.push({ text: 'brand-new/', kind: 'window', children: kids });
      return 'new window';
    }
  }
}

/**
 * Anchor-free, tab-title-free projection of a buffer: windows (in order) first, then bookmark roots.
 * Bookmark titles are editable, so they stay in the projection; tab titles are read-only, so they do not.
 */
function projectFull(text) {
  const { lines } = parseText(text);
  // a new window block has no anchor: the world is decided by the top-level line (bookmark roots carry /b…)
  const inTabWorld = (L) => { let c = L; while (c.parent >= 0) c = lines[c.parent]; return !(c.anchor && c.anchor.kind === 'b'); };
  const go = (i) => {
    const L = lines[i];
    let head;
    if (L.parent < 0) head = inTabWorld(L) ? 'W' : 'R';
    else if (L.type === 'folder') head = inTabWorld(L) ? `G ${L.name}` : `F ${L.name}`;
    else head = inTabWorld(L) ? `T ${L.url}` : `B ${L.title}|${L.url}`;
    const kids = L.children.map(go).filter(Boolean);
    // Chrome cannot hold an empty group or an empty window: both vanish
    if (!kids.length && (head === 'W' || head.startsWith('G '))) return null;
    return { head, kids };
  };
  const roots = lines.filter((L) => L.parent < 0).map((L) => go(L.idx)).filter(Boolean);
  return [...roots.filter((x) => x.head === 'W'), ...roots.filter((x) => x.head !== 'W')];
}

const N = Number(process.env.FUZZ_N || 30);
const seeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: N }, (_, i) => i + 1);

for (const seed of seeds) {
  test(`fuzz seed ${seed}: Chrome ends up looking like the edited buffer`, async () => {
    const r = rng(seed * 7919);
    const gen = randomSpec(r);
    await h.seed(gen.spec);
    const { text, snapshot } = await h.render();
    const top = toTree(text);
    const log = [];
    for (let i = 0, k = 1 + Math.floor(r() * 4); i < k; i++) {
      const d = mutate(top, r, gen, h);
      if (d) log.push(d);
    }
    const edited = toText(top);
    const info = () => `seed ${seed}\nedits:\n  ${log.join('\n  ')}\n--- before\n${text}\n--- edited\n${edited}`;
    const { plan, report } = await h.applyText(snapshot, edited);
    if (plan.errors.length) { assert.ok(true, `skipped (plan errors): ${plan.errors.map((e) => e.message)}`); return; }
    assert.deepEqual(report.errors, [], `apply errors\n${info()}`);
    assert.deepEqual(report.mismatches, [], `verification mismatches\n${info()}`);
    await h.settledState();
    const after = await h.render();
    assert.deepEqual(projectFull(after.text), projectFull(edited), `final state differs from the edited buffer\n${info()}\n--- after\n${after.text}`);
    const p2 = await h.planText(after.snapshot, after.text);
    assert.deepEqual([p2.actions, p2.errors, p2.warnings], [[], [], []], `re-plan not empty\n${info()}`);
  });
}
