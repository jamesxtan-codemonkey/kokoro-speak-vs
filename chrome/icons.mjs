// Draws the extension icon (a blue rounded square with white sound-wave bars)
// as PNGs, so the repo has no binary icon files to keep in sync.
import { crc32, deflateSync } from "node:zlib";

const BG = [26, 115, 232]; // #1a73e8
const FG = [255, 255, 255];

function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** RGBA pixels of the icon at `size` px, 4x4 supersampled. */
function draw(size) {
  // Fewer bars at small sizes so they stay distinct.
  const heights = size <= 16 ? [0.45, 1, 0.45] : [0.35, 0.7, 1, 0.7, 0.35];
  const n = heights.length;
  const pad = 0.22;
  const span = 1 - 2 * pad;
  const barW = span / (n * 2 - 1);
  const px = new Uint8Array(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (!roundedRect(u, v, 0, 0, 1, 1, 0.22)) continue;
          bg++;
          for (let i = 0; i < n; i++) {
            const bx0 = pad + i * 2 * barW;
            const h = heights[i] * 0.56;
            if (roundedRect(u, v, bx0, 0.5 - h / 2, bx0 + barW, 0.5 + h / 2, barW / 2)) {
              fg++;
              break;
            }
          }
        }
      }
      const o = (y * size + x) * 4;
      const a = bg / (S * S);
      const f = bg ? fg / bg : 0;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function iconPng(size) {
  const px = draw(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
