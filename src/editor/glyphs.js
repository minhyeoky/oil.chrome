// Inline SVG glyphs for the lines that have no favicon, and the Chrome tab-group colors as gruvbox CSS colors.

export const GROUP_COLOR_CSS = {
  grey: '#928374', blue: '#83a598', red: '#fb4934', yellow: '#fabd2f', green: '#b8bb26',
  pink: '#d3869b', purple: '#b16286', cyan: '#8ec07c', orange: '#fe8019',
};

const SVG = {
  window: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.75 6.25h12.5" stroke="currentColor" stroke-width="1.3"/>',
  group: '<rect x="2" y="4.25" width="12" height="7.5" rx="3.2" fill="currentColor"/>',
  folder: '<path d="M1.75 4.6a1.1 1.1 0 0 1 1.1-1.1h3.2l1.3 1.6h6a1.1 1.1 0 0 1 1.1 1.1v5.6a1.1 1.1 0 0 1-1.1 1.1H2.85a1.1 1.1 0 0 1-1.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  root: '<path d="M4.25 2.25h7.5v11.5L8 10.8l-3.75 2.95z" fill="currentColor"/>',
  bookmark: '<path d="M4.75 2.75h6.5v10L8 10.2l-3.25 2.55z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  tab: '<circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.6 8h10.8M8 2.6c1.9 1.7 1.9 9.1 0 10.8M8 2.6c-1.9 1.7-1.9 9.1 0 10.8" fill="none" stroke="currentColor" stroke-width="1"/>',
};

export const glyphSvg = (name) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${SVG[name] || SVG.tab}</svg>`;
