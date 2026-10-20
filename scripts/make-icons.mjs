// Generates icons/icon{16,48,128}.png: a gruvbox rounded square holding a tiny indented outline.
// Run once: node scripts/make-icons.mjs  (the PNGs are committed)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const png = (w, h, rgba) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
};

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG = hex('#282828');
const BARS = [ // [indent, length, y, color] in a 100×100 design space
  [18, 52, 24, '#fabd2f'], [32, 40, 40, '#8ec07c'], [46, 30, 56, '#d3869b'], [32, 36, 72, '#8ec07c'],
];

function drawIcon(size) {
  const SS = 4;
  const N = size * SS;
  const px = new Float32Array(N * N * 4);
  const inRound = (x, y, r) => {
    const cx = Math.min(Math.max(x, r), N - r); const cy = Math.min(Math.max(y, r), N - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      if (!inRound(x + 0.5, y + 0.5, N * 0.22)) continue;
      let col = BG;
      const u = ((x + 0.5) / N) * 100; const v = ((y + 0.5) / N) * 100;
      for (const [ix, len, by, c] of BARS) {
        if (u >= ix && u <= ix + len && v >= by - 4.5 && v <= by + 4.5) col = hex(c);
      }
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * N + x * SS + dx) * 4;
        const al = px[i + 3] / 255; r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, size, out);
}

mkdirSync(resolve(root, 'icons'), { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(resolve(root, `icons/icon${s}.png`), drawIcon(s));
console.log('icons written');
