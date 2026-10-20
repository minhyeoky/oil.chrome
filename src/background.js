// Service worker: the toolbar button and the command open the editor window.
// `globalThis.oilOpenEditor` is the same entry point, exposed for tests.

const EDITOR_URL = chrome.runtime.getURL('editor.html');
const WIDTH = 960;
const HEIGHT = 720;

async function findEditorWindow() {
  const wins = await chrome.windows.getAll({ populate: true });
  return wins.find((w) => w.type === 'popup' && (w.tabs || []).some((t) => (t.url || t.pendingUrl || '').startsWith(EDITOR_URL)));
}

async function lastFocusedNormalWindow() {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w && w.type === 'normal') return w;
  } catch { /* fall through */ }
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return all.find((w) => w.type === 'normal' && w.focused) || all.find((w) => w.type === 'normal') || null;
}

export async function openEditor() {
  const existing = await findEditorWindow();
  if (existing) {
    await chrome.windows.update(existing.id, { focused: true });
    return existing.id;
  }
  const anchor = await lastFocusedNormalWindow();
  const opts = { url: `${EDITOR_URL}${anchor ? `?focus=${anchor.id}` : ''}`, type: 'popup', width: WIDTH, height: HEIGHT, focused: true };
  if (anchor && anchor.width != null && anchor.left != null) {
    opts.left = Math.max(0, Math.round(anchor.left + (anchor.width - WIDTH) / 2));
    opts.top = Math.max(0, Math.round(anchor.top + (anchor.height - HEIGHT) / 2));
  }
  const win = await chrome.windows.create(opts);
  return win.id;
}

globalThis.oilOpenEditor = openEditor;
chrome.action.onClicked.addListener(() => { openEditor(); });
chrome.commands.onCommand.addListener((cmd) => { if (cmd === 'open-editor') openEditor(); });
