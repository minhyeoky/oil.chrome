// Modal overlays (DESIGN.md §7): the confirmation of a write, a notice (errors / apply report) and the help.
// They capture the keyboard while open (capture-phase listener) so nothing reaches the editor behind them.

import { summarize } from '../core/plan.js';

const GROUPS = [
  { id: 'del', title: 'Delete', kinds: ['close-tab', 'delete-bookmark', 'delete-folder', 'remove-group'] },
  { id: 'new', title: 'Create', kinds: ['new-window', 'new-tab', 'new-group', 'new-folder', 'new-bookmark'] },
  { id: 'move', title: 'Move', kinds: ['move-group', 'move-tab', 'move-folder', 'move-bookmark'] },
  { id: 'order', title: 'Reorder', kinds: ['reorder'] },
  { id: 'edit', title: 'Update', kinds: ['navigate-tab', 'edit-group', 'edit-folder', 'edit-bookmark'] },
];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Open an overlay; `onKey(e, close)` handles keys. Resolves with the value passed to `close`. */
function overlay(build, onKey) {
  return new Promise((resolve) => {
    const root = el('div', 'oil-overlay');
    const modal = el('div', 'oil-modal');
    root.appendChild(modal);
    const body = build(modal);
    document.body.appendChild(root);
    const close = (value) => {
      window.removeEventListener('keydown', handler, true);
      root.remove();
      resolve(value);
    };
    const handler = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      const scroller = body || modal;
      const page = scroller.clientHeight * 0.8;
      if (e.key === 'j' || e.key === 'ArrowDown') scroller.scrollBy(0, 38);
      else if (e.key === 'k' || e.key === 'ArrowUp') scroller.scrollBy(0, -38);
      else if ((e.key === 'd' && e.ctrlKey) || e.key === 'PageDown' || e.key === ' ') scroller.scrollBy(0, page);
      else if ((e.key === 'u' && e.ctrlKey) || e.key === 'PageUp') scroller.scrollBy(0, -page);
      else if (e.key === 'g') scroller.scrollTo(0, 0);
      else if (e.key === 'G') scroller.scrollTo(0, scroller.scrollHeight);
      else onKey(e, close);
    };
    window.addEventListener('keydown', handler, true);
    root.addEventListener('mousedown', (e) => { if (e.target === root) onKey({ key: 'Escape' }, close); });
  });
}

const deletionCount = (actions) => {
  let n = 0;
  for (const a of actions) {
    if (a.kind === 'close-tab' || a.kind === 'delete-bookmark') n++;
    else if (a.kind === 'delete-folder') n += 1 + a.count;
  }
  return n;
};

/** Confirmation of a write. Resolves true (apply) or false (cancel). */
export function showConfirm(plan) {
  const { actions, warnings } = plan;
  return overlay((modal) => {
    const head = el('div', 'oil-m-head');
    head.appendChild(el('span', 'oil-m-title', `Apply ${actions.length} change${actions.length === 1 ? '' : 's'}?`));
    modal.appendChild(head);

    const sub = el('div', 'oil-m-sub');
    const dels = deletionCount(actions);
    if (dels) sub.appendChild(el('span', 'oil-m-dels', `✕ ${dels} deletion${dels === 1 ? '' : 's'}`));
    const s = summarize(actions);
    const bits = [
      s.add && `+${s.add} new`, s.move && `→${s.move} moved`, s.reorder && `↕${s.reorder} reordered`,
      s.navigate && `↻${s.navigate} navigated`, s.edit && `✎${s.edit} edited`,
    ].filter(Boolean);
    if (bits.length) sub.appendChild(el('span', 'oil-m-bits', bits.join('   ')));
    modal.appendChild(sub);

    const body = el('div', 'oil-m-body');
    for (const g of GROUPS) {
      const rows = actions.filter((a) => g.kinds.includes(a.kind));
      if (!rows.length) continue;
      const sec = el('div', `oil-m-sec oil-m-${g.id}`);
      sec.appendChild(el('div', 'oil-m-sechead', `${g.title}  ${rows.length}`));
      for (const a of rows) {
        const m = /^(\S+)\s+(.*)$/s.exec(a.label);
        const row = el('div', 'oil-m-row');
        row.appendChild(el('span', 'oil-m-sig', m ? m[1] : ''));
        row.appendChild(el('span', 'oil-m-txt', m ? m[2] : a.label));
        sec.appendChild(row);
      }
      body.appendChild(sec);
    }
    if (warnings.length) {
      const sec = el('div', 'oil-m-sec oil-m-warn');
      sec.appendChild(el('div', 'oil-m-sechead', `Warnings  ${warnings.length}`));
      for (const w of warnings) {
        const row = el('div', 'oil-m-row');
        row.appendChild(el('span', 'oil-m-sig', '⚠'));
        row.appendChild(el('span', 'oil-m-txt', `line ${w.line + 1}: ${w.message}`));
        sec.appendChild(row);
      }
      body.appendChild(sec);
    }
    modal.appendChild(body);

    const foot = el('div', 'oil-m-foot');
    for (const [k, t] of [['y', 'apply'], ['n', 'cancel']]) {
      const b = el('span', 'oil-m-key');
      b.appendChild(el('kbd', null, k));
      b.appendChild(document.createTextNode(` ${t}`));
      foot.appendChild(b);
    }
    modal.appendChild(foot);
    return body;
  }, (e, close) => {
    if (['y', 'Y', 'o', 'O', 'Enter'].includes(e.key)) close(true);
    else if (['n', 'N', 'q', 'Escape'].includes(e.key)) close(false);
  });
}

/** A list of messages (plan errors, apply failures). Closes on q / Esc / Enter. */
export function showNotice({ title, kind = 'error', lines = [], footer = 'q close' }) {
  return overlay((modal) => {
    const head = el('div', `oil-m-head oil-m-head-${kind}`);
    head.appendChild(el('span', 'oil-m-title', title));
    modal.appendChild(head);
    const body = el('div', 'oil-m-body');
    for (const l of lines) {
      const row = el('div', 'oil-m-row');
      row.appendChild(el('span', 'oil-m-sig', l.sig ?? (kind === 'error' ? '✗' : '⚠')));
      row.appendChild(el('span', 'oil-m-txt', l.text));
      body.appendChild(row);
    }
    modal.appendChild(body);
    const foot = el('div', 'oil-m-foot');
    foot.appendChild(el('span', 'oil-m-key', footer));
    modal.appendChild(foot);
    return body;
  }, (e, close) => { if (['q', 'Escape', 'Enter'].includes(e.key)) close(); });
}

const HELP = [
  ['Write', [
    [':w', 'review the changes, then apply (y / n)'],
    [':wq  :x', 'apply, then close'],
    [':q  q', 'close (refused when modified, :q! forces)'],
    [':e!  R', 'reload from Chrome and discard edits'],
    ['<CR>', 'tab: switch to it · bookmark: open in a new tab'],
    ['', 'a modified buffer is kept open'],
    ['za zc zo zR zM', 'folds'],
    ['g?', 'this help'],
  ]],
  ['Editing', [
    ['dd', 'close a tab · delete a bookmark or folder block'],
    ['yy p P ]p', 'copy, paste, paste at the current indent'],
    ['>> <<', 'change the parent: window · group · folder'],
    ['cc cw S C', 'rename — the hidden anchor keeps the identity'],
    ['o  O', 'new line: a URL opens a tab or adds a bookmark'],
    ['name/', 'a folder-looking line is a new window, group or folder'],
    ['name [blue]/', 'a tab group (grey blue red yellow green pink purple cyan orange)'],
  ]],
  ['Marks', [
    ['+ new', 'created'], ['⧉ copy', 'a copy of a block'], ['→ Window 2', 'moved'], ['↻ navigate', 'URL changed'],
    ['✎ edit', 'renamed or recoloured'], ['★ bookmark', 'saved from a tab'], ['↗ open', 'opened from a bookmark'],
    ['⚠ …', 'applied, with a caveat'], ['✗ …', 'blocks the write'],
  ]],
];

/** Key reference + grammar. Closes on q / Esc / Enter / g? */
export function showHelp() {
  return overlay((modal) => {
    const head = el('div', 'oil-m-head');
    head.appendChild(el('span', 'oil-m-title', 'oil.chrome'));
    head.appendChild(el('span', 'oil-m-subtitle', 'the buffer is the desired state; identity lives in the hidden anchors'));
    modal.appendChild(head);
    const body = el('div', 'oil-m-body oil-m-help');
    for (const [title, rows] of HELP) {
      const sec = el('div', 'oil-m-sec');
      sec.appendChild(el('div', 'oil-m-sechead', title));
      for (const [k, t] of rows) {
        const row = el('div', 'oil-m-row');
        row.appendChild(el('span', 'oil-m-hk', k));
        row.appendChild(el('span', 'oil-m-txt', t));
        sec.appendChild(row);
      }
      body.appendChild(sec);
    }
    const warn = el('div', 'oil-m-sec oil-m-warn');
    warn.appendChild(el('div', 'oil-m-sechead', 'Careful'));
    const row = el('div', 'oil-m-row');
    row.appendChild(el('span', 'oil-m-sig', '⚠'));
    row.appendChild(el('span', 'oil-m-txt', 'bookmark deletions sync to every signed-in device and Chrome has no undo — a journal of the last 20 deletions is kept in extension storage.'));
    warn.appendChild(row);
    body.appendChild(warn);
    modal.appendChild(body);
    const foot = el('div', 'oil-m-foot');
    foot.appendChild(el('span', 'oil-m-key', 'q close'));
    modal.appendChild(foot);
    return body;
  }, (e, close) => { if (['q', 'Escape', 'Enter', '?'].includes(e.key)) close(); });
}
