// Anchors (DESIGN.md §7): conceal + atomic, deletion/insert protection, cursor constraint.
//
// Every outline line may start with a hidden anchor `/t12 ` after its indent. The editor draws a widget over it
// (favicon or glyph) that is atomic, and a transaction filter keeps the text itself safe:
//   · only a deletion that removes the whole line (its line break included — `dd`) may delete an anchor;
//     any other deletion touching an anchor is carved around it, so `cc` `S` `C` `D` `x` change the content and
//     keep the identity;
//   · an insertion inside or in front of an anchor (non-blank text) lands behind it; blank text in front of the
//     anchor (`>>`, a blank line above) and whole lines put above (`P`) are untouched;
//   · Enter right behind an anchor, before the first character of the content, breaks the line above the anchor
//     instead: anchor and content go down together, an empty line stays above, and the content is never left on a
//     line without an anchor (which `:w` would read as a copy);
//   · an empty cursor never rests in [line start, anchor end): it moves to the anchor end, so `0` `^` `I` go to the
//     first character of the name.

import { ChangeSet, EditorSelection, EditorState, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { indentService } from '@codemirror/language';
import { ANCHOR_SOURCE, parseLine, splitGroupName } from '../core/grammar.js';
import { folderKeyTest } from '../core/model.js';
import { GROUP_COLOR_CSS, glyphSvg } from './glyphs.js';

const ANCHOR_RE = new RegExp(ANCHOR_SOURCE);

/** Offsets of the anchor inside a line's text, or null: { a0, a1, kind, id } (a1 is exclusive and includes the space). */
export function anchorSpan(text) {
  const ws = /^[ \t]*/.exec(text)[0].length;
  const m = ANCHOR_RE.exec(text.slice(ws));
  return m ? { a0: ws, a1: ws + m[0].length, kind: m[1], id: m[2] } : null;
}

// ── change protection ───────────────────────────────────────────────────────

/** Same-length replacements (gu gU g~ ~ r, :s/x/y/): keep every character that is not part of a protected zone. */
function filterSameLength(doc, fromA, toA, text) {
  const zones = [];
  for (let n = doc.lineAt(fromA).number, last = doc.lineAt(toA).number; n <= last; n++) {
    const line = doc.line(n);
    const a = anchorSpan(line.text);
    if (a) zones.push([line.from > 0 ? line.from - 1 : line.from, line.from + a.a1]);
  }
  if (!zones.length) return null;
  const old = doc.sliceString(fromA, toA);
  const inZone = (pos) => zones.some(([s, e]) => pos >= s && pos < e);
  const specs = [];
  for (let i = 0; i < old.length; i++) {
    if (old[i] === text[i] || inZone(fromA + i)) continue;
    const prev = specs[specs.length - 1];
    if (prev && prev.to === fromA + i) { prev.to++; prev.insert += text[i]; } else specs.push({ from: fromA + i, to: fromA + i + 1, insert: text[i] });
  }
  return specs;
}

/** Rewrite one change (replace [fromA,toA) by `text`) so that anchors survive. Returns specs, or null when untouched. */
function filterChange(doc, fromA, toA, text) {
  if (fromA < toA && text.length === toA - fromA) return filterSameLength(doc, fromA, toA, text);
  const first = doc.lineAt(fromA).number;
  const last = doc.lineAt(toA).number;
  if (first === last && fromA < toA && text) { // a rewrite of anchor text itself is refused outright
    const line = doc.line(first);
    const a = anchorSpan(line.text);
    if (a && fromA >= line.from && toA <= line.from + a.a1) return [];
  }
  const protect = [];
  let insAt = fromA;
  let touched = false;
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    const a = anchorSpan(line.text);
    if (!a) continue;
    const lf = line.from;
    const lt = line.to;
    const a0 = lf + a.a0;
    const a1 = lf + a.a1;
    if (fromA === toA) { // pure insertion
      // Enter before the first character of the content: the break goes above the anchor, without auto-indent (the line
      // keeps its own), so that anchor and content go down together and no content is left on a line without anchor
      if (fromA === a1 && /^\n[ \t]*$/.test(text) && /\S/.test(line.text.slice(a.a1))) {
        return [{ from: lf, to: lf, insert: '\n' }];
      }
      if (fromA >= a1) continue;
      if (fromA <= a0 && /^\s*$/.test(text)) continue; // indentation, blank lines
      if (fromA === lf && text.endsWith('\n')) continue; // whole lines put above
      insAt = a1;
      touched = true;
      continue;
    }
    const wholeLine = fromA <= lf && toA >= lt && ((lt < doc.length && toA > lt) || (lf > 0 && fromA < lf));
    if (wholeLine) continue;
    if (toA > a0 && fromA < a1) { // the deletion reaches the anchor
      const s = fromA < lf ? lf - 1 : fromA === lf ? lf : Math.max(fromA, a0);
      protect.push([s, a1]);
      touched = true;
      if (text && fromA < a1) insAt = Math.max(insAt, a1);
    } else if (lf > 0 && fromA < lf && toA >= lf && fromA > doc.lineAt(fromA).from) {
      // would glue this line onto what is left of the line the deletion starts in (J, or a charwise delete across
      // whole lines); a deletion that starts at a line start leaves nothing to glue onto
      protect.push([lf - 1, lf]);
      touched = true;
    }
  }
  if (!touched) return null;

  const pieces = [];
  if (toA > fromA) {
    protect.sort((x, y) => x[0] - y[0]);
    let cur = fromA;
    for (const [s, e] of protect) {
      if (e <= cur) continue;
      if (s > cur) pieces.push([cur, Math.min(s, toA)]);
      cur = Math.max(cur, e);
      if (cur >= toA) break;
    }
    if (cur < toA) pieces.push([cur, toA]);
  }
  const specs = pieces.map(([from, to]) => ({ from, to, insert: '' }));
  if (text) {
    const i = specs.findIndex((s) => s.from === insAt);
    if (i >= 0) specs[i].insert = text;
    else {
      specs.push({ from: insAt, to: insAt, insert: text });
      specs.sort((x, y) => x.from - y.from);
    }
  }
  return specs;
}

/** The transaction's changes with anchors protected, or null when nothing needed protecting. */
export function protectChanges(startDoc, changes) {
  const specs = [];
  let touched = false;
  changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
    const text = inserted.toString();
    const r = filterChange(startDoc, fromA, toA, text);
    if (r) { touched = true; specs.push(...r); } else specs.push({ from: fromA, to: toA, insert: text });
  });
  if (!touched) return null;
  try {
    return ChangeSet.of(specs, startDoc.length);
  } catch {
    return ChangeSet.empty(startDoc.length); // conflicting rewrites: refuse the edit rather than risk an anchor
  }
}

/** Move an empty cursor out of [line start, anchor end). */
export function constrainRange(doc, range) {
  if (!range.empty) return range;
  const line = doc.lineAt(range.head);
  const a = anchorSpan(line.text);
  if (!a) return range;
  const a1 = line.from + a.a1;
  return range.head < a1 ? EditorSelection.cursor(a1) : range;
}

const annotationsOf = (tr) => {
  const out = [];
  const ue = tr.annotation(Transaction.userEvent);
  if (ue) out.push(Transaction.userEvent.of(ue));
  const ath = tr.annotation(Transaction.addToHistory);
  if (ath !== undefined) out.push(Transaction.addToHistory.of(ath));
  return out;
};

export const anchorFilter = EditorState.transactionFilter.of((tr) => {
  const startDoc = tr.startState.doc;
  const rewritten = tr.docChanged ? protectChanges(startDoc, tr.changes) : null;
  const changes = rewritten || tr.changes;
  const newDoc = rewritten ? rewritten.apply(startDoc) : tr.newDoc;

  let base = tr.newSelection;
  if (rewritten) {
    if (tr.selection) {
      const back = tr.changes.invertedDesc;
      base = EditorSelection.create(tr.selection.ranges.map((r) => EditorSelection.range(
        rewritten.mapPos(back.mapPos(r.anchor, 1), 1), rewritten.mapPos(back.mapPos(r.head, 1), 1),
      )), tr.selection.mainIndex);
    } else {
      base = tr.startState.selection.map(rewritten);
    }
  }
  const ranges = base.ranges.map((r) => constrainRange(newDoc, r));
  const moved = ranges.some((r, i) => r !== base.ranges[i]);
  if (!rewritten && !moved) return tr;
  return [{
    changes,
    selection: EditorSelection.create(ranges, base.mainIndex),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations: annotationsOf(tr),
  }];
});

// ── conceal: widget over every anchor ───────────────────────────────────────

function faviconUrl(pageUrl) {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(pageUrl)}&size=16`;
}

class AnchorWidget extends WidgetType {
  constructor(info) { super(); this.info = info; }

  eq(o) { return o.info.glyph === this.info.glyph && o.info.url === this.info.url && o.info.color === this.info.color; }

  toDOM() {
    const { glyph, url, color } = this.info;
    const el = document.createElement('span');
    el.className = `oil-anchor oil-a-${glyph}`;
    if (color) el.style.setProperty('--gc', GROUP_COLOR_CSS[color] || color);
    const setGlyph = (name) => { el.innerHTML = glyphSvg(name); };
    if (url) {
      const img = document.createElement('img');
      img.width = 16;
      img.height = 16;
      img.draggable = false;
      img.alt = '';
      img.addEventListener('error', () => { img.remove(); setGlyph('tab'); });
      img.src = faviconUrl(url);
      el.appendChild(img);
    } else setGlyph(glyph);
    return el;
  }

  ignoreEvent() { return false; }
}

/** What to draw over the anchor of a line; `isFolderKey` as for parseLine. */
export function anchorInfo(lineText, a, isFolderKey) {
  const p = parseLine(lineText, { isFolderKey });
  const indent = a.a0;
  switch (a.kind) {
    case 'w': return { glyph: 'window' };
    case 'g': return { glyph: 'group', color: p && p.type === 'folder' ? splitGroupName(p.name).color || 'grey' : 'grey' };
    case 't': return p && p.url ? { glyph: 'tab', url: p.url } : { glyph: 'tab' };
    default:
      if (p && p.type === 'folder') return { glyph: indent === 0 ? 'root' : 'folder' };
      return p && p.url ? { glyph: 'bookmark', url: p.url } : { glyph: 'bookmark' };
  }
}

function buildAnchors(view, ctx) {
  const ranges = [];
  const { doc } = view.state;
  const isFolderKey = folderKeyTest(ctx.getIndex());
  let prevLine = -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number === prevLine) continue;
      prevLine = line.number;
      const a = anchorSpan(line.text);
      if (!a) continue;
      ranges.push(Decoration.replace({ widget: new AnchorWidget(anchorInfo(line.text, a, isFolderKey)) }).range(line.from + a.a0, line.from + a.a1));
    }
  }
  return Decoration.set(ranges, true);
}

const anchorPlugin = (ctx) => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildAnchors(view, ctx); }

  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildAnchors(u.view, ctx); }
}, {
  decorations: (v) => v.decorations,
  provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
});

// ── indentation of new lines ────────────────────────────────────────────────
// `o` under a folder line starts its first child (one level in); `o` under anything else is a sibling.
// vim's `O` is implemented as "jump to the end of the previous line, then newline-and-indent", so the line it
// started from is lost; a small trail of the last two cursor lines recovers it, and `O` copies that line's indent.
const trailField = StateField.define({
  create: (state) => ({ prev: null, cur: state.doc.lineAt(state.selection.main.head).number }),
  update(v, tr) {
    const line = tr.state.doc.lineAt(tr.state.selection.main.head).number;
    if (tr.docChanged) return { prev: null, cur: line };
    return line === v.cur ? v : { prev: v.cur, cur: line };
  },
});

const indentOf = (text) => /^[ \t]*/.exec(text)[0].replace(/\t/g, '  ').length;

const outlineIndent = (ctx) => indentService.of((cm, pos) => {
  const { doc } = cm.state;
  const line = doc.lineAt(pos);
  const trail = cm.state.field(trailField, false);
  if (trail && trail.prev === line.number + 1 && trail.prev <= doc.lines) return indentOf(doc.line(trail.prev).text); // `O`
  const p = parseLine(line.text, { isFolderKey: folderKeyTest(ctx.getIndex()) });
  const base = indentOf(line.text);
  return p && p.type === 'folder' ? base + 2 : base;
});

/** @param ctx { getIndex(): indexSnapshot of the snapshot the buffer came from }: what the anchors of a line name */
export const anchorExtensions = (ctx) => [trailField, anchorPlugin(ctx), anchorFilter, outlineIndent(ctx)];
