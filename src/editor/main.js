// The editor window: CodeMirror 6 + vim over the outline text. Boots from live Chrome state, writes with :w.

import {
  deleteCharBackward, deleteCharForward, deleteGroupBackward, deleteGroupForward, deleteLineBoundaryBackward,
  deleteLineBoundaryForward, deleteToLineEnd, deleteToLineStart, history, indentLess, indentMore,
} from '@codemirror/commands';
import { foldAll, foldEffect, foldedRanges, indentUnit, unfoldAll, unfoldCode } from '@codemirror/language';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, runScopeHandlers } from '@codemirror/view';
import { Vim, getCM, vim } from '@replit/codemirror-vim';
import { apply, indexSnapshot, parseLine, plan, readSnapshot, render } from '../core/index.js';
import { anchorExtensions, anchorSpan } from './anchors.js';
import { showConfirm, showHelp, showNotice } from './confirm.js';
import { marksExtensions, pokeStatus } from './marks.js';
import { oilTheme } from './theme.js';

const EDITOR_URL = chrome.runtime.getURL('editor.html');
const params = new URLSearchParams(location.search);

const app = {
  view: null,
  snapshot: null, // S: the snapshot the buffer was rendered from
  ix: null,
  text: '',
  doc: null,
  focusWindowId: params.has('focus') ? Number(params.get('focus')) : null,
  busy: false,
  stale: false,
  message: null,
  messageTimer: null,
  refreshTimer: null,
};

const isDirty = () => !!(app.view && app.doc && !app.view.state.doc.eq(app.doc));
const ctx = {
  getSnapshot: () => app.snapshot,
  getIndex: () => app.ix,
  getStatus: () => ({ dirty: isDirty(), stale: app.stale, message: app.message }),
  onPlanError: (e) => flash(`preview failed: ${e && e.message ? e.message : e}`, 'error', 6000),
};

function flash(text, kind = 'info', ms = 5000) {
  app.message = { text, kind };
  clearTimeout(app.messageTimer);
  if (ms) app.messageTimer = setTimeout(() => { app.message = null; pokeStatus(app.view); }, ms);
  pokeStatus(app.view);
}

const readSnap = () => readSnapshot(chrome, { editorUrl: EDITOR_URL, focusWindowId: app.focusWindowId });

// ── state ───────────────────────────────────────────────────────────────────
// In insert mode, deletions run CodeMirror's commands, also for <C-w> <C-u> (vim's own are unmapped in wireVim). They
// act at every cursor of a blockwise insert, where the browser's own deletion changes the main line only and leaves the
// other cursors in front of the wrong characters; they leave the registers alone, as in Vim; and vim's `.` replays
// Backspace and Delete by looking them up in the editor's keymap.
const inserting = (run) => (view) => !!getCM(view)?.state.vim?.insertMode && run(view);
const insertModeDeletions = keymap.of([
  { key: 'Backspace', run: inserting(deleteCharBackward), shift: inserting(deleteCharBackward) },
  { key: 'Delete', run: inserting(deleteCharForward) },
  { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: inserting(deleteGroupBackward) },
  { key: 'Mod-Delete', mac: 'Alt-Delete', run: inserting(deleteGroupForward) },
  { mac: 'Mod-Backspace', run: inserting(deleteLineBoundaryBackward) },
  { mac: 'Mod-Delete', run: inserting(deleteLineBoundaryForward) },
  { mac: 'Ctrl-h', run: inserting(deleteCharBackward) },
  { mac: 'Ctrl-k', run: inserting(deleteToLineEnd) },
  { key: 'Ctrl-w', run: inserting(deleteGroupBackward) },
  { key: 'Ctrl-u', run: inserting(deleteToLineStart) },
]);
// Enter breaks the main line only in a blockwise insert, as in Vim: with several cursors it is handled before vim
const toMainCursor = (view) => { view.dispatch({ selection: EditorSelection.create([view.state.selection.main]) }); return false; };
const blockInsertKeys = keymap.of([
  { key: 'Enter', run: toMainCursor, shift: toMainCursor },
].map((binding) => ({ ...binding, scope: 'oil-block-insert' })));
const blockInsert = Prec.highest(EditorView.domEventHandlers({
  keydown: (event, view) => view.state.selection.ranges.length > 1 && !!getCM(view)?.state.vim?.insertMode
    && runScopeHandlers(view, event, 'oil-block-insert'),
}));

const extensions = [
  vim({ status: false }), // first: its keymap must win over everything below
  history(),
  // Tab must not leave the editor; in an outline it moves the line one level (the parent changes)
  keymap.of([{ key: 'Tab', run: indentMore, preventDefault: true }, { key: 'Shift-Tab', run: indentLess, preventDefault: true }]),
  insertModeDeletions,
  blockInsertKeys,
  blockInsert,
  drawSelection(),
  // blockwise visual mode (`<C-v>`) is one range per line; it stays the only way to get more than one
  EditorState.allowMultipleSelections.of(true),
  EditorView.clickAddsSelectionRange.of(() => false),
  highlightActiveLine(),
  EditorView.lineWrapping,
  EditorState.tabSize.of(2),
  indentUnit.of('  '),
  EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'oil.chrome outline' }),
  oilTheme,
  ...anchorExtensions(),
  ...marksExtensions(ctx),
  // the buffer became clean again (undo) while Chrome had changed: catch up
  EditorView.updateListener.of((u) => { if (u.docChanged && app.stale && !isDirty()) onChromeEvent(); }),
];

/** The line to rest on when the editor opens: the active tab of the last focused window. */
function initialLine(lines) {
  const wi = lines.findIndex((l) => l.kind === 'window' && l.focused);
  if (wi >= 0) {
    for (let i = wi + 1; i < lines.length && lines[i].kind !== 'blank'; i++) if (lines[i].kind === 'tab' && lines[i].active) return i;
    return wi;
  }
  const any = lines.findIndex((l) => l.kind === 'tab' && l.active);
  return any >= 0 ? any : 0;
}

const cursorKey = () => {
  const { state } = app.view;
  const a = anchorSpan(state.doc.lineAt(state.selection.main.head).text);
  return a ? `${a.kind}${a.id}` : null;
};

/** (Re)read Chrome, render, and replace the whole editor state (undo history reset; vim registers and folds persist). */
async function load({ keepCursor = false } = {}) {
  const snapshot = await readSnap();
  const { text, lines } = render(snapshot);
  const key = keepCursor ? cursorKey() : null;
  const prevLine = keepCursor ? app.view.state.doc.lineAt(app.view.state.selection.main.head).number - 1 : 0;
  let idx = keepCursor ? (key ? lines.findIndex((l) => l.key === key) : -1) : initialLine(lines);
  if (idx < 0) idx = Math.min(prevLine, lines.length - 1);
  const scrollTop = app.view.scrollDOM.scrollTop;

  app.snapshot = snapshot;
  app.ix = indexSnapshot(snapshot);
  app.text = text;
  app.stale = false;
  const doc = EditorState.create({ doc: text }).doc;
  const line = doc.line(idx + 1);
  const a = anchorSpan(line.text);
  const pos = line.from + (a ? a.a1 : /^[ \t]*/.exec(line.text)[0].length);
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(pos), extensions });
  app.doc = state.doc;
  const folded = foldedAnchors();
  app.view.setState(state);
  refold(folded);
  if (keepCursor) {
    app.view.scrollDOM.scrollTop = scrollTop;
    app.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 40 }) });
  } else {
    app.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  }
  app.view.focus();
}

// ── live refresh ────────────────────────────────────────────────────────────
async function refresh() {
  if (app.busy) return;
  let snapshot;
  try { snapshot = await readSnap(); } catch { return; }
  const { text } = render(snapshot);
  if (text === app.text) {
    if (!isDirty()) { app.snapshot = snapshot; app.ix = indexSnapshot(snapshot); }
    return;
  }
  if (isDirty()) { app.stale = true; pokeStatus(app.view); return; }
  await load({ keepCursor: true });
}

function onChromeEvent() {
  clearTimeout(app.refreshTimer);
  app.refreshTimer = setTimeout(refresh, 150);
}

function watchChrome() {
  const events = [
    chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached,
    chrome.tabs.onReplaced, chrome.windows.onCreated, chrome.windows.onRemoved, chrome.tabGroups.onCreated,
    chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved, chrome.bookmarks.onCreated,
    chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved, chrome.bookmarks.onChildrenReordered,
  ];
  for (const ev of events) ev.addListener(onChromeEvent);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if ('url' in info || 'title' in info || 'pinned' in info || 'groupId' in info) onChromeEvent();
  });
}

// ── commands ────────────────────────────────────────────────────────────────
async function closeEditor() {
  try {
    const w = await chrome.windows.getCurrent();
    await chrome.windows.remove(w.id);
  } catch { window.close(); }
}

function jumpToLine(n) {
  if (n == null || n < 0) return;
  const { doc } = app.view.state;
  const line = doc.line(Math.min(n + 1, doc.lines));
  const a = anchorSpan(line.text);
  app.view.dispatch({ selection: EditorSelection.cursor(line.from + (a ? a.a1 : 0)), scrollIntoView: true });
}

async function write({ quit: thenQuit = false } = {}) {
  if (app.busy) return false;
  app.busy = true;
  try {
    const fresh = await readSnap();
    const text = app.view.state.doc.toString();
    const p = plan(app.snapshot, fresh, text);
    if (p.errors.length) {
      jumpToLine(p.errors.find((e) => e.line >= 0)?.line);
      await showNotice({
        title: `${p.errors.length} error${p.errors.length === 1 ? '' : 's'} — nothing was applied`,
        lines: p.errors.map((e) => ({ text: e.line >= 0 ? `line ${e.line + 1}: ${e.message}` : e.message })),
      });
      return false;
    }
    if (!p.actions.length) {
      flash(p.warnings.length ? `nothing to apply (${p.warnings.length} warning${p.warnings.length === 1 ? '' : 's'})` : 'no changes');
      if (thenQuit) await closeEditor();
      return true;
    }
    if (!(await showConfirm(p))) { flash('cancelled'); return false; }
    flash('applying…', 'info', 0);
    const report = await apply(chrome, p);
    await load({ keepCursor: true });
    // windows created or touched by the write may have come to the front: bring the editor back
    try { await chrome.windows.update((await chrome.windows.getCurrent()).id, { focused: true }); } catch { /* the editor is going away */ }
    const problems = [
      ...report.errors.map((e) => ({ sig: '✗', text: `${e.op}: ${e.message}` })),
      ...report.mismatches.map((m) => ({ sig: '⚠', text: `layout differs from the buffer: ${m}` })),
    ];
    if (report.skippedDeletes) problems.push({ sig: '⚠', text: 'closing tabs and deleting bookmarks was skipped because something failed' });
    if (problems.length) {
      flash('applied with problems', 'warn', 8000);
      await showNotice({ title: 'Applied with problems', kind: 'warn', lines: problems });
    } else {
      const n = p.actions.length;
      const w = p.warnings.length;
      flash(`✓ applied ${n} change${n === 1 ? '' : 's'}${w ? ` · ${w} warning${w === 1 ? '' : 's'}` : ''}`, 'ok');
    }
    if (thenQuit && !problems.length) await closeEditor();
    return !problems.length;
  } catch (e) {
    flash(`write failed: ${e && e.message ? e.message : e}`, 'error', 9000);
    return false;
  } finally {
    app.busy = false;
    app.view.focus();
  }
}

function quit({ force = false } = {}) {
  if (isDirty() && !force) { flash('E37: No write since last change (add ! to override)', 'error'); return; }
  closeEditor();
}

async function reload({ force = false } = {}) {
  if (isDirty() && !force) { flash('E37: buffer modified — :e! discards the edits and reloads', 'error'); return; }
  if (app.busy) return;
  app.busy = true;
  try { await load({ keepCursor: true }); flash('reloaded'); } finally { app.busy = false; }
}

async function activate() {
  const { state } = app.view;
  const line = state.doc.lineAt(state.selection.main.head);
  const a = anchorSpan(line.text);
  const p = parseLine(line.text);
  if (!a || !p) { flash('nothing to open on this line'); return; }
  const finish = (msg) => {
    if (isDirty()) flash(`${msg} — buffer modified, the editor stays open`);
    else closeEditor();
  };
  try {
    if (a.kind === 't') {
      const tab = await chrome.tabs.get(Number(a.id));
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      finish('switched to the tab');
    } else if (a.kind === 'w') {
      await chrome.windows.update(Number(a.id), { focused: true });
      finish('switched to the window');
    } else if (a.kind === 'g') {
      const first = (await chrome.tabs.query({ groupId: Number(a.id) })).sort((x, y) => x.index - y.index)[0];
      if (!first) { flash('that group no longer exists', 'error'); return; }
      await chrome.tabs.update(first.id, { active: true });
      await chrome.windows.update(first.windowId, { focused: true });
      finish('switched to the group');
    } else if (p.type === 'folder') {
      foldToggle();
    } else {
      const url = p.url || (app.ix && app.ix.bm.get(`b${a.id}`)?.url);
      if (!url) { flash('this bookmark has no URL', 'error'); return; }
      const wins = (await chrome.windows.getAll()).filter((w) => w.type === 'normal');
      const target = wins.find((w) => w.id === app.focusWindowId) || wins[0];
      if (target) await chrome.tabs.create({ url, windowId: target.id, active: true });
      else await chrome.windows.create({ url });
      if (target) await chrome.windows.update(target.id, { focused: true });
      finish('opened in a new tab');
    }
  } catch (e) {
    flash(`cannot open: ${e && e.message ? e.message : e}`, 'error');
  }
}

// ── folds ───────────────────────────────────────────────────────────────────
function foldRangeAt(lineNumber) {
  const { state } = app.view;
  const line = state.doc.line(lineNumber);
  const p = parseLine(line.text);
  if (!p || p.type !== 'folder') return null;
  let end = lineNumber;
  for (let n = lineNumber + 1; n <= state.doc.lines; n++) {
    const q = parseLine(state.doc.line(n).text);
    if (!q) continue;
    if (q.indent <= p.indent) break;
    end = n;
  }
  return end > lineNumber ? { from: line.to, to: state.doc.line(end).to, start: lineNumber } : null;
}

/** The anchors of the folder lines that are folded right now (folds belong to the view, so a new document drops them). */
function foldedAnchors() {
  const { state } = app.view;
  const keys = new Set();
  foldedRanges(state).between(0, state.doc.length, (from) => {
    const a = anchorSpan(state.doc.lineAt(from).text);
    if (a) keys.add(`${a.kind}${a.id}`);
  });
  return keys;
}

/** Fold again the lines of the new document that carry one of these anchors, if they are still folder lines with children. */
function refold(keys) {
  if (!keys.size) return;
  const { state } = app.view;
  const effects = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const a = anchorSpan(state.doc.line(n).text);
    const r = a && keys.has(`${a.kind}${a.id}`) ? foldRangeAt(n) : null;
    if (r) effects.push(foldEffect.of({ from: r.from, to: r.to }));
  }
  // with the selection in the transaction, CodeMirror unfolds a block the cursor ended up inside
  if (effects.length) app.view.dispatch({ effects, selection: state.selection });
}

const isFolded = (range) => {
  let hit = false;
  foldedRanges(app.view.state).between(range.from, range.to, (f, t) => { if (f === range.from && t === range.to) hit = true; });
  return hit;
};

function enclosingFold() {
  const { state } = app.view;
  const cur = state.doc.lineAt(state.selection.main.head).number;
  for (let n = cur; n >= 1; n--) {
    const r = foldRangeAt(n);
    if (r && r.to >= state.doc.line(cur).to) return r;
  }
  return null;
}

function foldClose() {
  const r = enclosingFold();
  if (!r) return;
  const line = app.view.state.doc.line(r.start);
  const a = anchorSpan(line.text);
  app.view.dispatch({ effects: foldEffect.of({ from: r.from, to: r.to }), selection: EditorSelection.cursor(line.from + (a ? a.a1 : 0)) });
}

function foldToggle() {
  const { state } = app.view;
  const cur = state.doc.lineAt(state.selection.main.head);
  const own = foldRangeAt(cur.number);
  if (own && isFolded(own)) unfoldCode(app.view);
  else foldClose();
}

// ── vim wiring ──────────────────────────────────────────────────────────────
const bang = (params) => /^\s*!/.test((params && params.argString) || '');

function wireVim() {
  Vim.defineEx('write', 'w', () => { write(); });
  Vim.defineEx('wq', 'wq', () => { write({ quit: true }); });
  Vim.defineEx('xit', 'x', () => { write({ quit: true }); });
  Vim.defineEx('quit', 'q', (_cm, params) => { quit({ force: bang(params) }); });
  Vim.defineEx('edit', 'e', (_cm, params) => { reload({ force: bang(params) }); });

  const normal = { context: 'normal' };
  Vim.defineAction('oilReload', () => { reload({ force: true }); });
  Vim.defineAction('oilQuit', () => { quit(); });
  Vim.defineAction('oilActivate', () => { activate(); });
  Vim.defineAction('oilHelp', () => { showHelp().then(() => app.view.focus()); });
  Vim.defineAction('oilFoldToggle', () => foldToggle());
  Vim.defineAction('oilFoldClose', () => foldClose());
  Vim.defineAction('oilFoldOpen', () => unfoldCode(app.view));
  Vim.defineAction('oilFoldOpenAll', () => unfoldAll(app.view));
  Vim.defineAction('oilFoldCloseAll', () => foldAll(app.view));
  Vim.mapCommand('R', 'action', 'oilReload', {}, normal);
  Vim.mapCommand('q', 'action', 'oilQuit', {}, normal);
  Vim.mapCommand('<CR>', 'action', 'oilActivate', {}, normal);
  Vim.mapCommand('g?', 'action', 'oilHelp', {}, normal);
  Vim.mapCommand('za', 'action', 'oilFoldToggle', {}, normal);
  Vim.mapCommand('zc', 'action', 'oilFoldClose', {}, normal);
  Vim.mapCommand('zo', 'action', 'oilFoldOpen', {}, normal);
  Vim.mapCommand('zR', 'action', 'oilFoldOpenAll', {}, normal);
  Vim.mapCommand('zM', 'action', 'oilFoldCloseAll', {}, normal);

  /** The block's left column and the one after its right edge (Infinity for a `$` block). */
  const blockColumns = (cm) => {
    const { anchor, head } = cm.state.vim.sel;
    const headCh = head.ch === Infinity ? cm.getLine(head.line).length : head.ch;
    return { left: Math.min(anchor.ch, headCh), right: head.ch === Infinity ? Infinity : Math.max(anchor.ch, head.ch) + 1 };
  };
  // Blockwise `C` `D` run from the block's left column to the line end and `X` `Y` take the block itself, as in Vim. The
  // package runs all four to the line end, from its top corner's column, and one further unless that column is left of
  // the bottom corner's. Returns the arguments and ranges for the package's operator.
  const blockwise = (cm, args, ranges) => {
    if (!cm.state.vim.visualBlock || !args.linewise) return [args, ranges];
    const { left, right } = blockColumns(cm);
    const to = args.toEol ? Infinity : right;
    const block = ranges.map(({ anchor: { line } }) => ({ anchor: { line, ch: left }, head: { line, ch: to } }));
    cm.setSelections(block);
    return [{ ...args, linewise: false }, block];
  };
  // A blockwise insert (`I` `c` `C` `s`) types only into the lines that reach the block's left column, as in Vim. `A`
  // appends to every line, at the end of a short one (Vim pads it with spaces first).
  const reachingBlock = (cm, left) => {
    const cursors = cm.listSelections();
    const keep = cursors.filter((r) => cm.getLine(r.head.line).length >= left);
    if (keep.length && keep.length < cursors.length) cm.setSelections(keep);
  };

  // A linewise change keeps the anchor of its first line: lines 2..n go as with `dd`, then line 1 changes as with `cc`.
  // `<C-v>R` `<C-v>S` arrive linewise (exitVisualBlock); charwise `c`, `<C-v>c` `<C-v>s` stay the package's.
  // `this` is the package's operator table.
  Vim.defineOperator('oilChange', function oilChange(cm, args, ranges, ...rest) {
    const vim = cm.state.vim;
    if (vim.visualBlock) {
      const { left } = blockColumns(cm);
      const result = this.change(cm, ...blockwise(cm, args, ranges), ...rest);
      reachingBlock(cm, left);
      return result;
    }
    if (!args.linewise) return this.change(cm, args, ranges, ...rest);
    if (vim.visualMode) Vim.exitVisualMode(cm, false);
    const { anchor, head } = ranges[0];
    const last = Math.min(head.line - 1, cm.lastLine());
    if (last <= anchor.line) return this.change(cm, args, ranges, ...rest);
    const text = cm.getRange(anchor, head);
    cm.replaceRange('', { line: anchor.line, ch: Infinity }, { line: last, ch: Infinity });
    Vim.getRegisterController().pushText(args.registerName, 'change', text, true, false);
    const first = [{ anchor, head: { line: anchor.line + 1, ch: 0 } }];
    return this.change(cm, { ...args, registerName: '_' }, first, ...rest);
  });
  Vim.defineOperator('oilDelete', function oilDelete(cm, args, ranges, ...rest) {
    const block = cm.state.vim.visualBlock;
    const to = this.delete(cm, ...blockwise(cm, args, ranges), ...rest);
    // back in normal mode the cursor rests on a character, not behind the line end the deletion may have left it at
    return block && to ? { line: to.line, ch: Math.min(to.ch, Math.max(0, cm.getLine(to.line).length - 1)) } : to;
  });
  Vim.defineOperator('oilYank', function oilYank(cm, args, ranges, ...rest) {
    return this.yank(cm, ...blockwise(cm, args, ranges), ...rest);
  });
  Vim.unmap('<C-w>', 'insert'); // CodeMirror's commands take them (insertModeDeletions)
  Vim.unmap('<C-u>', 'insert');
  Vim.defineAction('oilInsert', function oilInsert(cm, args, vim) {
    const left = vim.visualBlock ? blockColumns(cm).left : null;
    this.enterInsertMode(cm, args, vim);
    if (left !== null) reachingBlock(cm, left);
  });
  // The package keeps a block's type in the register it was asked for only: the unnamed register, "1 and "- would
  // paste a block as plain text, line breaks and all
  const registers = Vim.getRegisterController();
  const pushText = registers.pushText.bind(registers);
  registers.pushText = (name, operator, text, linewise, blockwise) => {
    pushText(name, operator, text, linewise, blockwise);
    if (!blockwise || name === '_') return;
    registers.unnamedRegister.blockwise = true;
    if (!name && operator !== 'yank') registers.getRegister(text.includes('\n') ? '1' : '-').blockwise = true;
  };
  Vim.mapCommand('c', 'operator', 'oilChange', {}, {});
  const visual = { context: 'visual' };
  Vim.mapCommand('s', 'operator', 'oilChange', {}, visual);
  Vim.mapCommand('C', 'operator', 'oilChange', { linewise: true, toEol: true }, visual);
  Vim.mapCommand('D', 'operator', 'oilDelete', { linewise: true, toEol: true }, visual);
  Vim.mapCommand('X', 'operator', 'oilDelete', { linewise: true }, visual);
  Vim.mapCommand('Y', 'operator', 'oilYank', { linewise: true }, visual);
  Vim.mapCommand('I', 'action', 'oilInsert', { insertAt: 'startOfSelectedArea' }, { ...visual, isEdit: true });
  const lines = { ...visual, exitVisualBlock: true };
  Vim.mapCommand('R', 'operator', 'oilChange', { linewise: true }, lines);
  Vim.mapCommand('S', 'operator', 'oilChange', { linewise: true }, lines);
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  document.title = 'oil.chrome';
  app.view = new EditorView({ state: EditorState.create({ doc: '', extensions }), parent: document.getElementById('app') });
  wireVim();
  try {
    await load();
  } catch (e) {
    flash(`cannot read Chrome: ${e && e.message ? e.message : e}`, 'error', 0);
    throw e;
  }
  watchChrome();
  // handle for automation (tests, recordings): the editor itself does not use it
  globalThis.oil = {
    view: app.view, app, load, write, reload, quit, activate, isDirty,
    text: () => app.view.state.doc.toString(),
    plan: () => plan(app.snapshot, app.snapshot, app.view.state.doc.toString()),
  };
}

boot();
