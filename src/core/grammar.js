// Buffer grammar (DESIGN.md §2). Pure: no chrome APIs.
//
//   line    := indent anchor? content
//   anchor  := '/' kind id ' '         kind ∈ w g t b
//   content := folder | entry | ''
//   folder  := name '/'                (last token is not a URL and the line ends with '/')
//            | name | ''               (the anchor names a window, group or folder of the base snapshot; no URL token)
//   entry   := (title ' ')? url | title

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const ANCHOR_RE = /^\/([wgtb])(\d+)(?: |$)/;
const URL_TOKEN_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:\S+$/;
const COLOR_SUFFIX_RE = new RegExp(`(?:^|\\s)\\[(${GROUP_COLORS.join('|')})\\]$`);
const HOSTNAME = /(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}/.source; // example.com
const HTTP_HOST = /(?:[A-Za-z0-9-]+\.)*localhost|\d{1,3}(?:\.\d{1,3}){3}/.source; // localhost, app.localhost, 127.0.0.1
const PATH = /(?:[/?#]\S*)?/.source;
// a single bare token like `example.com`, `localhost` or `127.0.0.1:8080/path` (new tab lines only)
const BARE_HOST_RE = new RegExp(`^(?:${HTTP_HOST}|${HOSTNAME})(?::\\d+)?${PATH}$`, 'i');
// `localhost:3000` `example.com:8080`: a URL token whose "scheme" is a host and whose rest is a port
const HOST_PORT_RE = new RegExp(`^(?:${HTTP_HOST}|${HOSTNAME}):\\d+${PATH}$`, 'i');
const HTTP_HOST_RE = new RegExp(`^(?:${HTTP_HOST})(?:[:/?#]|$)`, 'i'); // opens over http, not https

export const normalizeTitle = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const normalizeUrl = (s) => String(s ?? '').trim().replace(/\s/g, '%20');

export const isUrlToken = (tok) => URL_TOKEN_RE.test(tok);
export const isBareHost = (tok) => BARE_HOST_RE.test(tok);

const withHttp = (hostAndRest) => `${HTTP_HOST_RE.test(hostAndRest) ? 'http' : 'https'}://${hostAndRest}`;

/**
 * The URL to write into Chrome for a URL token: `localhost:3000` and `example.com:8080` have no real scheme and get the
 * one a browser would give them; anything else is returned as is. Lines that were not edited are compared with the
 * stored URL before this, so an entity stored under such a URL keeps its line.
 */
export const withScheme = (url) => (HOST_PORT_RE.test(url) ? withHttp(url) : url);

export const anchorText = (kind, id) => `/${kind}${id} `;
export const anchorKey = (a) => (a ? `${a.kind}${a.id}` : null);

/** Leading-anchor regexp source, shared with the editor. */
export const ANCHOR_SOURCE = ANCHOR_RE.source;

/**
 * Parse one raw buffer line. Returns null for blank lines.
 * { indent, anchor:{kind,id,len,start}|null, type:'folder'|'entry'|'empty', name?, title?, url?, content }
 *  - `indent` counts a tab as 2 columns; `anchor.start` is the string offset of the anchor in `raw`.
 *  - An anchor that names a folder keeps its line a folder when the `/` is edited away (`cc` clears it): the line is a
 *    folder unless its last token is a URL, its name is the content without one trailing `/`, and it is never `empty`.
 *  - The grammar cannot know what an anchor names. `isFolderKey('b10')` answers for every kind (an anchor the base
 *    snapshot does not have reads as no anchor); without it every `w` and `g` anchor names a folder, `b` and `t` none.
 */
export function parseLine(raw, { isFolderKey } = {}) {
  if (/^\s*$/.test(raw)) return null;
  const ws = /^[ \t]*/.exec(raw)[0];
  let indent = 0;
  for (const c of ws) indent += c === '\t' ? 2 : 1;
  let rest = raw.slice(ws.length);
  let anchor = null;
  const am = ANCHOR_RE.exec(rest);
  if (am) {
    anchor = { kind: am[1], id: am[2], len: am[0].length, start: ws.length };
    rest = rest.slice(am[0].length);
  }
  const content = rest.replace(/\s+$/, '').replace(/^\s+/, '');
  const line = { indent, anchor, content };
  const folderAnchor = !!anchor
    && (isFolderKey ? !!isFolderKey(anchorKey(anchor)) : anchor.kind === 'w' || anchor.kind === 'g');
  if (content === '') return folderAnchor ? { ...line, type: 'folder', name: '' } : { ...line, type: 'empty', title: '', url: null };
  const last = content.slice(content.search(/\S+$/));
  if (isUrlToken(last)) {
    return {
      ...line,
      type: 'entry',
      url: normalizeUrl(last),
      title: normalizeTitle(content.slice(0, content.length - last.length)),
    };
  }
  if (content.endsWith('/')) {
    return { ...line, type: 'folder', name: normalizeTitle(content.slice(0, -1)) };
  }
  if (folderAnchor) return { ...line, type: 'folder', name: normalizeTitle(content) };
  return { ...line, type: 'entry', title: normalizeTitle(content), url: null };
}

/** Folder content for a name. A trailing `/` is appended; if that makes the last token look like a URL, ` /` is used. */
export function folderContent(name) {
  const base = `${name}/`;
  const last = base.slice(base.search(/\S+$/));
  return isUrlToken(last) ? `${name} /` : base;
}

export function entryContent(title, url) {
  return title ? `${title} ${url}` : url;
}

export function groupContent(title, color) {
  return title ? `${title} [${color}]/` : `[${color}]/`;
}

/** `Research [blue]` → { title:'Research', color:'blue' }; no suffix → { title:name, color:null }. */
export function splitGroupName(name) {
  const m = COLOR_SUFFIX_RE.exec(name);
  if (!m) return { title: normalizeTitle(name), color: null };
  return { title: normalizeTitle(name.slice(0, m.index)), color: m[1] };
}

/** Fix-ups for a new-tab line that has no URL token. Returns a URL or null. */
export function bareHostUrl(line) {
  if (line.type !== 'entry' || line.url || !line.title) return null;
  if (/\s/.test(line.title)) return null;
  return isBareHost(line.title) ? withHttp(line.title) : null;
}
