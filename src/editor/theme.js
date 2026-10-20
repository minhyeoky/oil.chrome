// gruvbox dark for the editor internals. Overlays (confirm, help) live in editor.css.

import { EditorView } from '@codemirror/view';

export const C = {
  bg0h: '#1d2021', bg0: '#282828', bg1: '#3c3836', bg2: '#504945', bg3: '#665c54', bg4: '#7c6f64',
  fg: '#ebdbb2', fg2: '#d5c4a1', fg4: '#a89984', gray: '#928374',
  red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', purple: '#d3869b', aqua: '#8ec07c', orange: '#fe8019',
};

export const FONT = '"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, Menlo, monospace';

export const oilTheme = EditorView.theme({
  '&': { color: C.fg, backgroundColor: C.bg0, height: '100%', fontSize: '13.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: FONT, lineHeight: '1.62', overflow: 'auto' },
  '.cm-content': { padding: '6px 0 48px', caretColor: C.orange },
  '.cm-line': { padding: '0 14px 0 6px' },

  // block cursor (vim) and selections
  '.cm-fat-cursor, &.cm-focused .cm-fat-cursor': { background: `${C.orange} !important`, color: `${C.bg0} !important`, outline: 'none' },
  '&:not(.cm-focused) .cm-fat-cursor': { background: 'none !important', outline: `1px solid ${C.orange}`, color: 'inherit !important' },
  '.cm-cursor': { borderLeftColor: C.orange },
  '.cm-selectionBackground, .cm-content ::selection': { background: `${C.bg3} !important` },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: `${C.bg3} !important` },
  '.cm-activeLine': { backgroundColor: `${C.bg1}b3` },
  '.cm-searchMatch': { backgroundColor: `${C.yellow}33`, outline: `1px solid ${C.yellow}66` },
  '.cm-searchMatch-selected': { backgroundColor: `${C.orange}55` },

  // gutter: relative numbers
  '.cm-gutters': { backgroundColor: C.bg0, color: C.bg4, border: 'none', paddingRight: '2px' },
  '.oil-ln': { minWidth: '3.2ch', textAlign: 'right', padding: '0 8px 0 10px', color: C.bg3 },
  '.oil-ln-cur': { color: C.yellow, fontWeight: '600' },

  // bottom panels: status line above the ex command line
  '.cm-panels': { backgroundColor: C.bg0h, color: C.fg, border: 'none' },
  '.cm-panels-bottom': { borderTop: `1px solid ${C.bg1}` },
  '.cm-vim-panel': { padding: '2px 12px', fontFamily: FONT, fontSize: '13px', color: C.fg, backgroundColor: C.bg0h, minHeight: '1.5em' },
  '.cm-vim-panel input': { color: C.fg, fontFamily: FONT, fontSize: '13px' },
  '.cm-vim-panel span': { fontFamily: FONT },
  '.cm-fold': { color: C.bg4 },
  '.cm-foldPlaceholder': { display: 'none' },
}, { dark: true });
