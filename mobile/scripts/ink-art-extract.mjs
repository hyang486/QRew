// Turns ink art extracted from the Qrew design PDF (opaque off-white RGB) into a transparent PNG in ink
// #181817: alpha follows how dark each pixel is, so anti-aliased line edges stay smooth. Crops to the drawing
// with a margin and halves the size of very large images.
//
// Usage: node scripts/ink-art-extract.mjs <in.png> <out.png>
// Source images: `pdfimages -png -p Qrew_heytea_UI.pdf <prefix>` (Q 01.04 runner = page 1 image 1,
// Q 01.01 gathering = page 1 image 0, Q 02.01 gate = page 2 image 2, Q 02.03 paper = page 2 image 3,
// Q 06.01 reference = page 6 image 0, Q 06.04 ended = page 6 image 2, Q 07.04 camera = page 7 image 2;
// pdfimages -f N -l N numbers from 000 per range).
import { readFileSync, writeFileSync } from 'node:fs';

import { PNG } from 'pngjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: ink-art-extract.mjs <in.png> <out.png>');

const INK = [0x18, 0x18, 0x17];
const PAPER = 238; // lighter than this is background
const SOLID = 60; // darker than this is full ink
const MARGIN = 8;
const MAX_WIDTH = 900;

const src = PNG.sync.read(readFileSync(input));
const { width, height } = src;
const alpha = new Uint8Array(width * height);
let [x0, y0, x1, y1] = [width, height, -1, -1];
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const lum = 0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2];
    const a = Math.round(Math.min(1, Math.max(0, (PAPER - lum) / (PAPER - SOLID))) * 255);
    alpha[y * width + x] = a;
    if (a > 16) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
}
x0 = Math.max(0, x0 - MARGIN);
y0 = Math.max(0, y0 - MARGIN);
x1 = Math.min(width - 1, x1 + MARGIN);
y1 = Math.min(height - 1, y1 + MARGIN);

const scale = x1 - x0 + 1 > MAX_WIDTH ? 2 : 1;
const w = Math.floor((x1 - x0 + 1) / scale);
const h = Math.floor((y1 - y0 + 1) / scale);
const out = new PNG({ width: w, height: h });
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) sum += alpha[(y0 + y * scale + dy) * width + (x0 + x * scale + dx)];
    }
    const o = (y * w + x) * 4;
    out.data[o] = INK[0];
    out.data[o + 1] = INK[1];
    out.data[o + 2] = INK[2];
    out.data[o + 3] = Math.round(sum / (scale * scale));
  }
}
writeFileSync(output, PNG.sync.write(out, { colorType: 6 }));
console.log(`${output}: ${w}x${h} (from ${width}x${height}, crop ${x0},${y0}-${x1},${y1}, scale 1/${scale})`);
