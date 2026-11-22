// Генерация иконок приложения без внешних зависимостей.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets');
fs.mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len = vx * vx + vy * vy;
  const t = len ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function render(size, scale = 4) {
  const W = size * scale;
  const out = Buffer.alloc(size * size * 4);
  const radius = 0.235;
  const margin = size >= 64 ? 0.015 : 0.03;
  const strokeWidth = 0.047;
  const strokes = [
    [0.345, 0.315, 0.345, 0.685],
    [0.345, 0.315, 0.655, 0.685],
    [0.655, 0.315, 0.655, 0.685],
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = (x + (sx + 0.5) / scale) / size;
          const py = (y + (sy + 0.5) / scale) / size;

          const dx = Math.abs(px - 0.5) - (0.5 - margin - radius);
          const dy = Math.abs(py - 0.5) - (0.5 - margin - radius);
          const sdf = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
          if (sdf > 0) continue;

          const t = Math.min(1, Math.max(0, (px + py) / 2));
          let cr = mix(124, 34, t);
          let cg = mix(92, 211, t);
          let cb = mix(255, 238, t);

          const glow = Math.max(0, 1 - Math.hypot(px - 0.28, py - 0.22) * 2.2);
          cr = mix(cr, 255, glow * 0.22);
          cg = mix(cg, 255, glow * 0.22);
          cb = mix(cb, 255, glow * 0.22);

          let inLetter = false;
          for (const [ax, ay, bx, by] of strokes) {
            if (distToSegment(px, py, ax, ay, bx, by) <= strokeWidth) {
              inLetter = true;
              break;
            }
          }
          if (inLetter) {
            cr = 250;
            cg = 250;
            cb = 255;
          }

          r += cr;
          g += cg;
          b += cb;
          a += 1;
        }
      }
      const total = scale * scale;
      const index = (y * size + x) * 4;
      out[index] = Math.round(r / total);
      out[index + 1] = Math.round(g / total);
      out[index + 2] = Math.round(b / total);
      out[index + 3] = Math.round((a / total) * 255);
    }
  }
  return encodePng(size, size, out);
}

fs.writeFileSync(path.join(outDir, 'icon.png'), render(256, 4));
fs.writeFileSync(path.join(outDir, 'tray.png'), render(32, 4));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), render(512, 2));
console.log('Иконки созданы: assets/icon.png, assets/tray.png, assets/icon-512.png');
