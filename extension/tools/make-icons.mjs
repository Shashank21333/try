// Generates the extension icons (icons/icon{16,32,48,128}.png) from code:
// a red rounded square with a white magnifier around a "play" triangle.
// Zero dependencies: shapes are rasterized with 4x4 supersampling and written
// as RGBA PNGs with node:zlib. Run: node extension/tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const ACCENT = [229, 72, 77]; // --accent of the dashboard (#e5484d)
const SIZES = [16, 32, 48, 128];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- shapes in unit coordinates (0..1) ----
function inRoundedSquare(x, y, m, r) {
  const lo = m + r;
  const hi = 1 - m - r;
  const dx = Math.max(lo - x, 0, x - hi);
  const dy = Math.max(lo - y, 0, y - hi);
  return x >= m && x <= 1 - m && y >= m && y <= 1 - m && dx * dx + dy * dy <= r * r;
}
function distToSegment(px, py, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}
function inTriangle(px, py, [a, b, c]) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p = [px, py];
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function isWhite(x, y) {
  const cx = 0.44;
  const cy = 0.44;
  const ring = Math.abs(Math.hypot(x - cx, y - cy) - 0.215) <= 0.045;
  const handle = distToSegment(x, y, 0.61, 0.61, 0.77, 0.77) <= 0.06;
  const play = inTriangle(x, y, [[0.385, 0.35], [0.385, 0.53], [0.535, 0.44]]);
  return ring || handle || play;
}

function render(size) {
  const margin = size >= 48 ? 0.0625 : 0; // Chrome's store guidance: padding around larger icons
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let white = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundedSquare(x, y, margin, 0.22)) continue;
          // the artwork is scaled into the padded square
          const ux = (x - margin) / (1 - 2 * margin);
          const uy = (y - margin) / (1 - 2 * margin);
          if (isWhite(ux, uy)) white++;
          else bg++;
        }
      }
      const total = SS * SS;
      const a = (bg + white) / total;
      const i = (py * size + px) * 4;
      if (a === 0) continue;
      const w = white / (bg + white);
      for (let k = 0; k < 3; k++) buf[i + k] = Math.round(ACCENT[k] * (1 - w) + 255 * w);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, buf);
}

mkdirSync(OUT, { recursive: true });
for (const s of SIZES) {
  writeFileSync(path.join(OUT, `icon${s}.png`), render(s));
  console.log(`wrote icons/icon${s}.png`);
}
