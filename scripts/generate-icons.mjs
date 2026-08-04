// 生成扩展图标：彩色（命中）+ 灰色（未命中）两套，16/32/48/128。
// PNG 是用 Node 内置 zlib 手搓的，零依赖。
// 用法: node scripts/generate-icons.mjs

import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(OUT_DIR, { recursive: true });

// --- PNG 编码 ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter byte: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- 画调色盘：圆盘 + 拇指孔 + 三颗颜料点 ---

function drawIcon(size, colored) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const R = size * 0.46;

  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  const base1 = colored ? [0x63, 0x66, 0xf1] : [0x9a, 0xa0, 0xa6]; // indigo / 灰
  const base2 = colored ? [0xa8, 0x55, 0xf7] : [0x7a, 0x80, 0x86]; // purple / 深灰
  const dabs = colored
    ? [[0xff, 0xd1, 0x66], [0x6e, 0xe7, 0xb7], [0x93, 0xc5, 0xfd]] // 黄绿蓝颜料
    : [[0xd0, 0xd4, 0xda], [0xc2, 0xc6, 0xcc], [0xd6, 0xda, 0xe0]];

  const set = (x, y, [r, g, b], a) => {
    const i = (y * size + x) * 4;
    const na = a + px[i + 3] * (1 - a); // alpha 叠到底色上
    if (na === 0) return;
    px[i]     = Math.round((r * a + px[i] * px[i + 3] * (1 - a)) / na);
    px[i + 1] = Math.round((g * a + px[i + 1] * px[i + 3] * (1 - a)) / na);
    px[i + 2] = Math.round((b * a + px[i + 2] * px[i + 3] * (1 - a)) / na);
    px[i + 3] = Math.round(na * 255);
  };

  const disc = (cx, cy, r, colorFn) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const edge = r - d; // >0 在圆内
        if (edge <= -0.5) continue;
        const a = Math.min(1, Math.max(0, edge + 0.5)); // 边缘 1px 抗锯齿
        set(x, y, colorFn(x, y), a);
      }
    }
  };

  // 主圆盘，对角线渐变
  disc(c, c, R, (x, y) => {
    const t = (x + y) / (2 * size);
    return [lerp(base1[0], base2[0], t), lerp(base1[1], base2[1], t), lerp(base1[2], base2[2], t)];
  });

  // 拇指孔：先画上去再抠成透明
  const holeR = size * 0.11;
  disc(c + R * 0.52, c + R * 0.52, holeR, () => [0, 0, 0]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - (c + R * 0.52), y + 0.5 - (c + R * 0.52));
      if (holeR - d > 0.5) { px[(y * size + x) * 4 + 3] = 0; }
    }
  }

  // 颜料点，上半圈排三个
  const dabR = size * 0.085;
  [[-0.45, -0.42], [0.05, -0.58], [0.52, -0.32]].forEach(([dx, dy], i) => {
    disc(c + R * dx * 1.6, c + R * dy * 1.6, dabR, () => dabs[i]);
  });

  return px;
}

for (const size of [16, 32, 48, 128]) {
  for (const [suffix, colored] of [['', true], ['-gray', false]]) {
    const file = join(OUT_DIR, `icon${size}${suffix}.png`);
    writeFileSync(file, encodePNG(size, drawIcon(size, colored)));
    console.log('生成', file);
  }
}
