// Generators for the identity property tests: nasty titles/URLs, random windows/groups/bookmark trees.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NASTY_TITLES = [
  '', ' ', 'plain', 'two words', 'a   b', 'tab\tname', 'multi\nline', 'trailing/', 'foo//', '//', '/', '[blue]', 'x [red]',
  'x [red] [blue]', 'Re:', 'a:b', 'http://not-a-url', 'ends with https://x.test/', 'ends with url:', '/t1 fake', '/b10 fake folder/',
  'C++ & Rust', '日本語 タイトル', 'emoji-ish ★ ✎ ↗', 'a/b/c', 'quote "x"', '  leading', 'trailing  ', 'Window 1', 'about:blank',
  'folder/ name', ' / ', '[grey]/', 'mailto:me@example.com', 'Q&A:',
];

/** Titles shaped like `host:port` next to real schemes: all must survive as names and titles. */
export const HOST_PORT_TITLES = [
  'localhost:3000', 'localhost:3000/', 'example.com:8080', '127.0.0.1:8080/x', 'a.b.com:80?q=1#f', 'LocalHost:3000', 'localhost:abc',
  'tel:123', 'mailto:a@b.c', 'chrome://settings', 'http://localhost:3000/',
];

export function randomTitle(r) {
  if (r() < 0.55) return NASTY_TITLES[Math.floor(r() * NASTY_TITLES.length)];
  const pool = ['a', 'b', 'c', ' ', ' ', '/', '[', ']', ':', '\n', '\t', 'é', '日', '-', '.', 'x', 'y', '1'];
  let s = '';
  const n = Math.floor(r() * 12);
  for (let i = 0; i < n; i++) s += pool[Math.floor(r() * pool.length)];
  return s;
}

const SCHEMES = ['http', 'https', 'https', 'https', 'chrome', 'file', 'about', 'ftp', 'view-source', 'chrome-extension'];
export function randomUrl(r) {
  const scheme = SCHEMES[Math.floor(r() * SCHEMES.length)];
  if (scheme === 'about') return r() < 0.5 ? 'about:blank' : 'about:srcdoc';
  const host = ['example.com', 'a.test', 'localhost:8080', 'github.com', 'x.y.z'][Math.floor(r() * 5)];
  let path = '';
  if (r() < 0.7) path = `/${['a', 'b c', 'a%20b', 'x?y=1 2', 'p/q/', '', '#frag', 'tab\tstop', 'nl\nq'][Math.floor(r() * 9)]}`;
  return `${scheme}://${host}${path}`;
}

const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export function randomSnapshot(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  let tid = 100;
  let gid = 500;
  const windows = [];
  const groups = [];
  const nWin = 1 + Math.floor(r() * 3);
  for (let wi = 0; wi < nWin; wi++) {
    const wid = 1000 + wi * 7;
    const n = 1 + Math.floor(r() * 7);
    const tabs = [];
    const nPinned = r() < 0.4 ? Math.floor(r() * Math.min(3, n)) : 0;
    for (let i = 0; i < n; i++) {
      tabs.push({ id: tid++, index: i, title: randomTitle(r), url: r() < 0.05 ? '' : randomUrl(r), pendingUrl: r() < 0.5 ? randomUrl(r) : '', pinned: i < nPinned, active: false, groupId: -1 });
    }
    tabs[Math.floor(r() * n)].active = true;
    // contiguous unpinned runs become groups
    let i = nPinned;
    while (i < n) {
      if (r() < 0.45) {
        const len = 1 + Math.floor(r() * Math.min(3, n - i));
        const id = gid++;
        groups.push({ id, windowId: wid, title: randomTitle(r), color: pick(COLORS), collapsed: r() < 0.2 });
        for (let j = i; j < i + len; j++) tabs[j].groupId = id;
        i += len;
      } else i++;
    }
    windows.push({ id: wid, focused: wi === 0, tabs });
  }
  let bid = 10;
  const mkFolder = (depth) => {
    const kids = [];
    const n = Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      if (depth < 3 && r() < 0.35) kids.push(mkFolder(depth + 1));
      else kids.push({ id: String(bid++), title: randomTitle(r), url: randomUrl(r) });
    }
    return { id: String(bid++), title: randomTitle(r), children: kids };
  };
  const roots = ['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks'].map((title, i) => ({
    id: String(i + 1), title, children: Array.from({ length: Math.floor(r() * 4) }, () => (r() < 0.5 ? mkFolder(1) : { id: String(bid++), title: randomTitle(r), url: randomUrl(r) })),
  }));
  return { windows, groups, bookmarks: roots };
}

/** A hand-written snapshot that exercises every normalisation and escaping rule at once. */
export function complexSnapshot() {
  const t = (id, index, title, url, extra = {}) => ({ id, index, title, url, pinned: false, active: false, groupId: -1, ...extra });
  return {
    windows: [
      {
        id: 101, focused: true,
        tabs: [
          t(1, 0, 'Pinned one', 'https://pinned.test/', { pinned: true }),
          t(2, 1, 'Pinned two', 'https://pinned2.test/', { pinned: true }),
          t(3, 2, '', 'https://no-title.test/', { active: true }),
          t(4, 3, 'multi\nline\ttitle   with  gaps', 'https://x.test/a b?q=1 2'),
          t(5, 4, 'ends with slash/', 'https://x.test/'),
          t(6, 5, 'looks like [blue]', 'https://x.test/b', { groupId: 9 }),
          t(7, 6, '/t1 pretend anchor', 'about:blank', { groupId: 9 }),
          t(8, 7, 'Re:', 'chrome://extensions/', { groupId: 10 }),
          t(9, 8, '日本語', '', { groupId: 10 }),
          t(10, 9, 'tail', 'file:///tmp/a b.txt'),
        ],
      },
      {
        id: 202, focused: false,
        tabs: [
          t(20, 0, 'solo', 'https://solo.test/'), t(21, 1, 'x', 'javascript:void(0)'),
          t(22, 2, 'localhost:3000', 'http://localhost:3000/', { groupId: 11 }), t(23, 3, '127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'),
        ],
      },
    ],
    groups: [
      { id: 9, windowId: 101, title: 'x [red]', color: 'red', collapsed: false },
      { id: 10, windowId: 101, title: '', color: 'blue', collapsed: true },
      { id: 11, windowId: 202, title: 'example.com:8080', color: 'green', collapsed: false },
    ],
    bookmarks: [
      {
        id: '1', title: 'Bookmarks bar',
        children: [
          { id: '10', title: 'foo/', children: [{ id: '11', title: 'trailing/', url: 'https://t.test/' }] },
          { id: '12', title: 'Re:', children: [] },
          { id: '13', title: 'http://looks.like/url', children: [{ id: '14', title: '', url: 'https://empty-title.test/' }] },
          { id: '15', title: '[grey]/', children: [] },
          { id: '16', title: '', children: [] },
          { id: '17', title: 'ends with url https://x.test/', url: 'https://y.test/p q' },
          { id: '18', title: 'localhost:3000', children: [{ id: '19', title: 'example.com:8080', url: 'https://example.com:8080/' }] },
          // stored without a scheme (another extension, or an older build of this one, wrote them like that)
          { id: '22', title: 'Dev', url: 'localhost:3000' },
          { id: '23', title: '', url: 'localhost:3000/' },
          { id: '24', title: 'x', url: 'example.com:8080/' },
        ],
      },
      { id: '2', title: 'Other bookmarks', children: [] },
      { id: '3', title: 'Mobile bookmarks', children: [] },
    ],
  };
}
