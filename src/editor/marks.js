// Syntax highlighting, preview marks, status line, relative numbers and folds (DESIGN.md §7).
//
// Everything here is derived from the buffer text alone (plus the base snapshot S for facts the text does not
// carry: which tab is active/pinned, which window is focused). Preview marks run plan(S, S, text) on every
// document change: immediately in normal mode, 40 ms debounced in insert mode.

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, showPanel } from '@codemirror/view';
import { codeFolding, foldService } from '@codemirror/language';
import { getCM } from '@replit/codemirror-vim';
import { GROUP_COLORS, parseLine, splitGroupName } from '../core/grammar.js';
import { parseText } from '../core/parse.js';
import { assignRoles, plan, summaryText } from '../core/plan.js';
import { anchorSpan } from './anchors.js';
import { GROUP_COLOR_CSS } from './glyphs.js';
import { C } from './theme.js';

const COLOR_SUFFIX = new RegExp(` ?\\[(?:${GROUP_COLORS.join('|')})\\]$`);

// ── syntax ──────────────────────────────────────────────────────────────────

function buildSyntax(view, ctx) {
  const { doc } = view.state;
  const { lines } = parseText(doc.toString());
  const ix = ctx.getIndex();
  assignRoles(lines, new Set(ix ? ix.rootKeys : []));
  const out = [];
  for (const L of lines) {
    const line = doc.line(L.n + 1);
    const text = line.text;
    const trimmed = text.replace(/\s+$/, '');
    const lead = /^[ \t]*(?:\/[wgtb]\d+(?: |$))?\s*/.exec(text)[0].length;
    let cls = `oil-l oil-r-${L.role}`;
    let style = `--n:${L.indent};--w:${L.anchor ? 2 : 0}`;
    const tab = ix && L.anchor && L.anchor.kind === 't' && L.role === 'tab' ? ix.tabs.get(L.akey) : null;
    if (tab && tab.active) cls += ' oil-active';
    if (tab && tab.pinned) cls += ' oil-pinned';
    if (L.role === 'group') style += `;--gc:${GROUP_COLOR_CSS[splitGroupName(L.name).color || 'grey']}`;
    out.push(Decoration.line({ class: cls, attributes: { style } }).range(line.from));

    const cs = line.from + lead;
    const ce = line.from + trimmed.length;
    if (cs >= ce) continue;
    if (L.type === 'folder') {
      const nameEnd = ce - 1;
      const suffix = L.role === 'group' ? COLOR_SUFFIX.exec(text.slice(0, trimmed.length - 1)) : null;
      const sfx = suffix ? line.from + suffix.index : nameEnd;
      if (sfx > cs) out.push(Decoration.mark({ class: 'oil-name' }).range(cs, sfx));
      if (suffix) out.push(Decoration.mark({ class: 'oil-gcolor' }).range(sfx, nameEnd));
      out.push(Decoration.mark({ class: 'oil-slash' }).range(nameEnd, ce));
    } else if (L.url) {
      const m = /\S+$/.exec(trimmed);
      const us = line.from + m.index;
      if (us > cs) out.push(Decoration.mark({ class: 'oil-title' }).range(cs, us));
      out.push(Decoration.mark({ class: 'oil-url' }).range(us, ce));
    } else {
      out.push(Decoration.mark({ class: 'oil-title' }).range(cs, ce));
    }
  }
  return Decoration.set(out, true);
}

const syntaxPlugin = (ctx) => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildSyntax(view, ctx); }

  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildSyntax(u.view, ctx); }
}, { decorations: (v) => v.decorations });

// ── preview marks ───────────────────────────────────────────────────────────

class MarkWidget extends WidgetType {
  constructor(items) { super(); this.items = items; this.key = JSON.stringify(items); }

  eq(o) { return o.key === this.key; }

  toDOM() {
    const el = document.createElement('span');
    el.className = 'oil-marks';
    for (const it of this.items) {
      const s = document.createElement('span');
      s.className = `oil-mark oil-mark-${it.kind}`;
      s.textContent = it.text;
      el.appendChild(s);
    }
    return el;
  }

  ignoreEvent() { return true; }
}

const setPreview = StateEffect.define();
export const previewField = StateField.define({
  create: () => ({ decos: Decoration.none, plan: null, summary: '', errors: 0, warnings: 0 }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPreview)) return e.value;
    return tr.docChanged ? { ...v, decos: v.decos.map(tr.changes) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/** Informational (not preview) text after a line: tab counts, focused window, pinned/active tabs. */
function lineInfo(lines, L, ix) {
  const items = [];
  const count = (role) => {
    let n = 0;
    const walk = (i) => { for (const c of lines[i].children) { if (lines[c].role === role) n++; walk(c); } };
    walk(L.idx);
    return n;
  };
  if (L.role === 'window') {
    const n = count('tab');
    const w = ix && L.anchor && L.anchor.kind === 'w' ? ix.windows.get(L.akey) : null;
    items.push({ kind: 'info', text: `· ${n} tab${n === 1 ? '' : 's'}${w && w.focused ? ' · focused' : ''}` });
  } else if (L.role === 'group') {
    const n = count('tab');
    items.push({ kind: 'info', text: `· ${n} tab${n === 1 ? '' : 's'}` });
  } else if (L.role === 'broot' || L.role === 'bfolder') {
    const n = count('bookmark');
    if (n) items.push({ kind: 'info', text: `· ${n}` });
  } else if (L.role === 'tab' && ix && L.anchor && L.anchor.kind === 't') {
    const t = ix.tabs.get(L.akey);
    if (t && t.pinned) items.push({ kind: 'info', text: '· pinned' });
    if (t && t.active) items.push({ kind: 'info', text: '· active' });
  }
  return items;
}

function computePreview(view, ctx) {
  const text = view.state.doc.toString();
  const snapshot = ctx.getSnapshot();
  if (!snapshot) return { decos: Decoration.none, plan: null, summary: '', errors: 0, warnings: 0 };
  let p;
  try {
    p = plan(snapshot, snapshot, text);
  } catch (e) {
    ctx.onPlanError?.(e);
    return { decos: Decoration.none, plan: null, summary: '', errors: 0, warnings: 0 };
  }
  const { lines } = parseText(text);
  const ix = ctx.getIndex();
  assignRoles(lines, new Set(ix ? ix.rootKeys : []));
  const byLine = new Map();
  const add = (n, item) => { if (!byLine.has(n)) byLine.set(n, []); byLine.get(n).push(item); };
  for (const L of lines) for (const it of lineInfo(lines, L, ix)) add(L.n, it);
  for (const m of p.marks) add(m.line, { kind: m.kind, text: m.text });
  const doc = view.state.doc;
  const decos = [];
  for (const [n, items] of byLine) {
    if (n + 1 > doc.lines) continue;
    decos.push(Decoration.widget({ widget: new MarkWidget(items), side: 1 }).range(doc.line(n + 1).to));
  }
  return {
    decos: Decoration.set(decos, true), plan: p, summary: summaryText(p.actions), errors: p.errors.length, warnings: p.warnings.length,
  };
}

const previewPlugin = (ctx) => ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.timer = null;
    this.alive = true;
    queueMicrotask(() => this.compute());
  }

  insertMode() {
    const cm = getCM(this.view);
    return !!(cm && cm.state.vim && cm.state.vim.insertMode);
  }

  update(u) {
    if (!u.docChanged) return;
    clearTimeout(this.timer);
    if (this.insertMode()) this.timer = setTimeout(() => this.compute(), 40);
    else queueMicrotask(() => this.compute());
  }

  compute() {
    if (!this.alive) return;
    this.view.dispatch({ effects: setPreview.of(computePreview(this.view, ctx)) });
  }

  destroy() { this.alive = false; clearTimeout(this.timer); }
});

// ── relative line numbers ───────────────────────────────────────────────────

class Num extends GutterMarker {
  constructor(text, cur) { super(); this.text = text; this.cur = cur; }

  eq(o) { return o.text === this.text && o.cur === this.cur; }

  toDOM() {
    const s = document.createElement('span');
    s.className = this.cur ? 'oil-ln oil-ln-cur' : 'oil-ln';
    s.textContent = this.text;
    return s;
  }
}

const relativeNumbers = gutter({
  class: 'oil-gutter',
  lineMarker(view, line) {
    const cur = view.state.doc.lineAt(view.state.selection.main.head).number;
    const n = view.state.doc.lineAt(line.from).number;
    return new Num(n === cur ? String(n) : String(Math.abs(n - cur)), n === cur);
  },
  lineMarkerChange: (u) => u.selectionSet || u.docChanged || u.viewportChanged,
  initialSpacer: () => new Num('000', false),
});

// ── folds ───────────────────────────────────────────────────────────────────

const outlineFold = (state, from) => {
  const { doc } = state;
  const line = doc.lineAt(from);
  const p = parseLine(line.text);
  if (!p || p.type !== 'folder') return null;
  let end = line.number;
  for (let n = line.number + 1; n <= doc.lines; n++) {
    const q = parseLine(doc.line(n).text);
    if (!q) continue;
    if (q.indent <= p.indent) break;
    end = n;
  }
  return end > line.number ? { from: line.to, to: doc.line(end).to } : null;
};

const foldExtensions = [
  foldService.of(outlineFold),
  codeFolding({
    preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
    placeholderDOM: (view, onclick, prepared) => {
      const el = document.createElement('span');
      el.className = 'oil-fold';
      el.textContent = ` ⋯ ${prepared}`;
      el.addEventListener('click', onclick);
      return el;
    },
  }),
];

// ── status line ─────────────────────────────────────────────────────────────

function modeLabel(view) {
  const cm = getCM(view);
  const v = cm && cm.state.vim;
  if (!v) return 'NORMAL';
  if (v.insertMode) return /replace/.test(v.mode || '') ? 'REPLACE' : 'INSERT';
  if (v.visualMode) return v.visualBlock ? 'V-BLOCK' : v.visualLine ? 'V-LINE' : 'VISUAL';
  return 'NORMAL';
}

const poke = StateEffect.define();
export const pokeStatus = (view) => view.dispatch({ effects: poke.of(null) });

function statusPanel(ctx) {
  return (view) => {
    const dom = document.createElement('div');
    dom.className = 'oil-status';
    const seg = (cls) => { const s = document.createElement('span'); s.className = cls; dom.appendChild(s); return s; };
    const mode = seg('oil-s-mode');
    const flag = seg('oil-s-flag');
    const sum = seg('oil-s-sum');
    const diag = seg('oil-s-diag');
    const msg = seg('oil-s-msg');
    const pos = seg('oil-s-pos');
    let attached = false;
    const refresh = (v) => {
      const label = modeLabel(v);
      mode.textContent = label;
      mode.dataset.mode = label.toLowerCase();
      const pv = v.state.field(previewField, false);
      const st = ctx.getStatus();
      flag.textContent = st.dirty ? '[+]' : '';
      sum.textContent = pv ? pv.summary : '';
      const bits = [];
      if (pv && pv.warnings) bits.push(`⚠ ${pv.warnings}`);
      if (pv && pv.errors) bits.push(`✗ ${pv.errors}`);
      diag.textContent = bits.join('  ');
      diag.className = `oil-s-diag${pv && pv.errors ? ' oil-s-err' : ''}`;
      let text = '';
      let cls = 'oil-s-msg';
      if (st.stale) { text = '⟳ chrome changed — :e! to reload'; cls += ' oil-s-warn'; }
      else if (st.message) { text = st.message.text; cls += ` oil-s-${st.message.kind || 'info'}`; }
      msg.textContent = text;
      msg.className = cls;
      const head = v.state.selection.main.head;
      const line = v.state.doc.lineAt(head);
      const a = anchorSpan(line.text);
      const col = head - line.from - (a ? a.a1 : 0) + 1; // columns are counted from the name, not from the hidden anchor
      pos.textContent = `${line.number}/${v.state.doc.lines}  ${Math.max(col, 1)}`;
    };
    const attach = () => {
      if (attached) return;
      const cm = getCM(view);
      if (!cm) return;
      attached = true;
      const onChange = () => refresh(view);
      cm.on('vim-mode-change', onChange);
      cm.on('vim-command-done', onChange);
    };
    queueMicrotask(() => { attach(); refresh(view); });
    return {
      dom,
      update(u) { attach(); refresh(u.view); },
      destroy() { /* listeners die with the vim plugin */ },
    };
  };
}

// ── theme for everything above ──────────────────────────────────────────────

const marksTheme = EditorView.theme({
  // hanging indent: wrapped lines continue under the first character of the name
  '.cm-line.oil-l': {
    paddingLeft: 'calc(6px + (var(--n) + var(--w)) * 1ch)',
    textIndent: 'calc(-1 * (var(--n) + var(--w)) * 1ch)',
  },
  '.oil-anchor': { display: 'inline-flex', width: '2ch', height: '1.2em', alignItems: 'center', justifyContent: 'center', verticalAlign: 'text-bottom', textIndent: '0' },
  // a light chip behind favicons: dark glyphs (GitHub's octocat) would vanish on the dark background
  '.oil-anchor img': { width: '14px', height: '14px', padding: '1px', boxSizing: 'content-box', borderRadius: '3.5px', display: 'block', background: 'rgba(213, 196, 161, 0.94)' },
  '.oil-anchor svg': { width: '14px', height: '14px', display: 'block' },
  '.oil-a-window': { color: C.yellow },
  '.oil-a-root': { color: C.orange },
  '.oil-a-folder': { color: C.aqua },
  '.oil-a-group': { color: 'var(--gc, #928374)' },
  '.oil-a-tab': { color: C.fg4 },
  '.oil-a-bookmark': { color: C.purple },

  '.oil-r-window .oil-name': { color: C.yellow, fontWeight: '600' },
  '.oil-r-broot .oil-name': { color: C.orange, fontWeight: '600' },
  '.oil-r-bfolder .oil-name': { color: C.aqua, fontWeight: '500' },
  '.oil-r-group .oil-name': { color: 'var(--gc)', fontWeight: '600' },
  '.oil-r-group .oil-gcolor': { color: 'var(--gc)', opacity: '0.7' },
  '.oil-slash': { color: C.bg3 },
  '.oil-title': { color: C.fg },
  '.oil-url': { color: C.bg4 },
  '.oil-r-invalid, .oil-r-invalid .oil-title, .oil-r-invalid .oil-name, .oil-r-invalid .oil-url': { color: C.red },
  '.oil-active': { boxShadow: `inset 2px 0 0 ${C.aqua}` },
  '.oil-pinned .oil-title': { fontStyle: 'italic' },

  '.oil-marks': { marginLeft: '1.2ch', whiteSpace: 'nowrap', userSelect: 'none', pointerEvents: 'none', textIndent: '0' },
  '.oil-mark': { marginRight: '1ch', fontSize: '0.92em' },
  '.oil-mark-info': { color: C.bg4 },
  '.oil-mark-new': { color: C.green },
  '.oil-mark-copy, .oil-mark-open': { color: C.aqua },
  '.oil-mark-move': { color: C.blue },
  '.oil-mark-navigate, .oil-mark-edit': { color: C.yellow },
  '.oil-mark-bookmark': { color: C.purple },
  '.oil-mark-warn': { color: C.orange },
  '.oil-mark-error': { color: C.red, fontWeight: '600' },
  '.oil-fold': { color: C.bg4, background: C.bg1, borderRadius: '3px', padding: '0 4px', cursor: 'pointer', marginLeft: '0.6ch' },

  '.oil-status': { display: 'flex', alignItems: 'baseline', gap: '14px', padding: '3px 12px', fontSize: '12.5px', color: C.fg4, whiteSpace: 'nowrap' },
  '.oil-s-mode': { fontWeight: '700', color: C.bg0, background: C.fg4, borderRadius: '3px', padding: '0 7px', letterSpacing: '0.04em' },
  '.oil-s-mode[data-mode="insert"]': { background: C.green },
  '.oil-s-mode[data-mode="replace"]': { background: C.red },
  '.oil-s-mode[data-mode^="v"]': { background: C.orange },
  '.oil-s-flag': { color: C.orange, fontWeight: '700' },
  '.oil-s-sum': { color: C.fg },
  '.oil-s-diag': { color: C.orange },
  '.oil-s-diag.oil-s-err': { color: C.red },
  '.oil-s-msg': { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', color: C.fg4 },
  '.oil-s-msg.oil-s-warn': { color: C.orange },
  '.oil-s-msg.oil-s-ok': { color: C.green },
  '.oil-s-msg.oil-s-error': { color: C.red },
  '.oil-s-pos': { color: C.bg4 },
}, { dark: true });

/**
 * @param ctx { getSnapshot(): raw snapshot, getIndex(): indexSnapshot, getStatus(): { dirty, stale, message } }
 */
export function marksExtensions(ctx) {
  return [
    marksTheme,
    syntaxPlugin(ctx),
    previewField,
    previewPlugin(ctx),
    relativeNumbers,
    foldExtensions,
    showPanel.of(statusPanel(ctx)),
  ];
}
