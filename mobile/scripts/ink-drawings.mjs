// Qrew redesign A1: generates the dev ink drawings (hike, bike, motorcycle) for src/lib/ink-art.ts.
// Closed paths (ending Z) are paper-filled so they hide what is drawn behind them; open paths are strokes only.
// Usage: node scripts/ink-drawings.mjs <outDir>  → <outDir>/drawings.ts.txt (paste into INK_DRAWINGS) and
// <outDir>/<key>.svg previews (white paper, light-mode ink) to check by eye before pasting.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node scripts/ink-drawings.mjs <outDir>');
mkdirSync(OUT, { recursive: true });

const r1 = (n) => Math.round(n * 10) / 10;
const pt = (p) => `${r1(p[0])} ${r1(p[1])}`;

// Catmull-Rom through pts as cubic segments (without the initial M).
function cr(pts) {
  let s = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    s += ` C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return s;
}
export const line = (...pts) => `M${pt(pts[0])}${cr(pts)}`;

// A limb/body tube: centerline pts with half-widths ws, round caps, closed.
export function tube(pts, ws) {
  const n = pts.length;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const w = ws[i] ?? ws[ws.length - 1];
    L.push([pts[i][0] - dy * w, pts[i][1] + dx * w]);
    R.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
  }
  const we = ws[n - 1] ?? ws[ws.length - 1], w0 = ws[0];
  const Rr = [...R].reverse();
  return `M${pt(L[0])}${cr(L)} A${r1(we)} ${r1(we)} 0 0 0 ${pt(R[n - 1])}${cr(Rr)} A${r1(w0)} ${r1(w0)} 0 0 0 ${pt(L[0])} Z`;
}
export const circle = (cx, cy, r, closed = true) =>
  `M${pt([cx + r, cy])} A${r} ${r} 0 1 1 ${pt([cx - r, cy])} A${r} ${r} 0 1 1 ${pt([cx + r, cy])}${closed ? ' Z' : ''}`;
export const ring = (cx, cy, r) => circle(cx, cy, r, false); // unfilled circle
export const blob = (...pts) => `M${pt(pts[0])}${cr([...pts, pts[0]])} Z`; // smooth closed shape

function spokes(cx, cy, r, n, rot = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * Math.PI) / (n / 2);
    out.push(`M${pt([cx + Math.cos(a) * 3, cy + Math.sin(a) * 3])} L${pt([cx + Math.cos(a) * r, cy + Math.sin(a) * r])}`);
  }
  return out;
}

/** @type {Record<string, string[]>} */
const D = {};


// soft wavy hair cap over a head: bumps along an arc, closed along the forehead/nape
function hairCap(cx, cy, r, from, to, bumps, lift = 5) {
  const P = (a, rr) => [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  let d = `M${pt(P(from, r - 2))}`;
  for (let i = 0; i < bumps; i++) {
    const a0 = from + ((to - from) * i) / bumps, a1 = from + ((to - from) * (i + 1)) / bumps;
    d += ` Q${pt(P((a0 + a1) / 2, r + lift))} ${pt(P(a1, r + 1))}`;
  }
  return d;
}

// ---------- BIKE: a person riding a bicycle to the right ----------
{
  const Rw = [64, 222], Fw = [236, 222], r = 49, BB = [142, 226];
  const S = [124, 150], H = [204, 148];
  const p = [];
  p.push(ring(...Rw, r), ring(...Rw, r - 5), ...spokes(...Rw, r - 5, 10, 0.2), ring(...Rw, 4));
  p.push(ring(...Fw, r), ring(...Fw, r - 5), ...spokes(...Fw, r - 5, 10, 0.5), ring(...Fw, 4));
  // far leg + crank
  p.push(`M${pt(BB)} L120 206`);
  p.push(tube([[128, 134], [160, 178], [128, 204]], [11, 9, 6.5]));
  p.push(blob([112, 202], [134, 198], [140, 207], [113, 210]));
  // frame, fork, bars, saddle
  p.push(`M${pt(Rw)} L${pt(BB)} L${pt(S)} L${pt(Rw)} M${pt(S)} L${pt(H)} L${pt(BB)}`);
  p.push(`M${pt(H)} L210 166 L${pt(Fw)}`);
  p.push(`M${pt(H)} L208 128 M198 128 Q214 122 224 130`);
  p.push(`M122 150 L120 140`);
  p.push(blob([100, 136], [138, 134], [140, 141], [104, 143]));
  p.push(ring(...BB, 10));
  // near leg, shoe, crank
  p.push(`M${pt(BB)} L164 246`);
  p.push(tube([[140, 140], [182, 170], [166, 232]], [11, 9.5, 6.5]));
  p.push(blob([150, 243], [176, 239], [187, 248], [153, 252]));
  // shorts on the saddle, then the t-shirt over the waist
  p.push(blob([104, 134], [112, 116], [140, 116], [162, 140], [158, 158], [140, 156], [118, 142]));
  p.push(`M150 156 Q156 150 158 142`);
  p.push(blob([104, 126], [114, 100], [140, 80], [166, 70], [184, 76], [186, 92], [168, 104], [150, 118], [140, 130], [116, 132]));
  // near arm: sleeve, forearm, hand on the bar
  p.push(tube([[184, 88], [200, 110], [214, 126]], [6.5, 6, 5]));
  p.push(blob([168, 76], [186, 74], [194, 88], [184, 96], [172, 90]));
  p.push(circle(216, 127, 6));
  // neck, head, ear, eye, wavy hair
  p.push(`M186 76 L190 70`);
  p.push(circle(196, 54, 17));
  p.push(`M208 56 Q210 57 209 59`);
  p.push(`M188 56 Q184 58 187 62`);
  p.push(hairCap(196, 54, 17, Math.PI * 0.8, Math.PI * 1.85, 6, 6) + ` Q202 46 196 44 Q186 48 182 62 Z`);
  D.bike = p;
}

// ---------- HIKE: a person with a backpack climbing to the right ----------
{
  const p = [];
  p.push(line([8, 268], [80, 260], [160, 250], [230, 240], [294, 228]));
  p.push(`M200 150 L246 92 L268 118 L292 160`);
  p.push(`M232 110 L239 115 L245 106 L252 115 L258 110`);
  // far arm, far leg back
  p.push(tube([[160, 90], [152, 122], [146, 144]], [6.5, 6, 5]));
  p.push(tube([[150, 148], [136, 198], [114, 244]], [11, 9, 6.5]));
  p.push(blob([96, 250], [122, 244], [130, 256], [98, 260]));
  // near leg stepping up, boot
  p.push(tube([[156, 146], [196, 184], [196, 232]], [11, 9.5, 6.5]));
  p.push(blob([184, 236], [212, 232], [222, 243], [188, 247]));
  // shorts, shirt
  p.push(blob([138, 140], [160, 132], [184, 158], [180, 176], [164, 178], [140, 162]));
  p.push(`M176 176 Q182 168 182 158`);
  p.push(blob([140, 146], [146, 112], [160, 80], [180, 74], [186, 92], [176, 120], [172, 146], [156, 150]));
  // backpack with lid and pocket, strap over the shoulder
  p.push(blob([114, 88], [146, 76], [160, 98], [158, 140], [146, 152], [120, 150], [108, 122]));
  p.push(blob([112, 90], [126, 72], [150, 68], [160, 86], [140, 92]));
  p.push(`M118 124 Q134 118 154 124 L152 142 Q134 146 118 140 Z`);
  p.push(`M160 94 Q172 100 170 124`);
  // pole + near arm + hand
  p.push(`M226 102 L242 238`);
  p.push(tube([[178, 88], [198, 118], [222, 114]], [6.5, 6, 5]));
  p.push(blob([166, 80], [184, 78], [190, 94], [180, 102], [170, 96]));
  p.push(circle(225, 113, 6));
  // neck, head, ear, eye, cap
  p.push(`M176 74 L180 68`);
  p.push(circle(186, 52, 17));
  p.push(`M198 54 Q200 55 199 57`);
  p.push(`M178 54 Q174 56 177 60`);
  p.push(`M168 46 Q172 30 188 32 Q202 34 204 44 L218 45 Q216 50 202 50 L168 49 Z`);
  D.hike = p;
}

// ---------- MOTORCYCLE: a person in a helmet riding a motorcycle ----------
{
  const Rw = [62, 222], Fw = [238, 222];
  const p = [];
  for (const w of [Rw, Fw]) p.push(ring(...w, 47), ring(...w, 36), ring(...w, 30), ring(...w, 8));
  p.push(`M14 212 Q20 166 62 162 Q96 164 108 186`);
  p.push(`M194 196 Q210 166 240 164 Q270 166 284 198`);
  p.push(`M200 120 L234 220 M210 116 L244 216`);
  p.push(tube([[100, 206], [150, 214]], [6, 6]));
  p.push(`M62 222 L130 196`);
  p.push(blob([128, 166], [176, 162], [186, 194], [170, 212], [134, 210], [124, 190]));
  p.push(`M134 178 L178 176 M132 190 L182 188 M136 202 L176 200`);
  p.push(ring(150, 216, 9));
  p.push(blob([78, 152], [128, 146], [132, 160], [82, 164]));
  p.push(blob([126, 140], [168, 126], [204, 134], [200, 156], [134, 160]));
  p.push(circle(222, 140, 11));
  p.push(`M224 132 Q230 136 230 144`);
  // near leg on the peg, boot
  p.push(`M168 210 L188 212`);
  p.push(tube([[132, 140], [182, 152], [174, 198]], [12, 10.5, 8]));
  p.push(blob([162, 196], [190, 192], [196, 207], [164, 210]));
  // jacket (riders sit more upright), collar
  p.push(blob([104, 146], [110, 108], [132, 80], [160, 72], [176, 88], [164, 116], [150, 146], [128, 152]));
  p.push(`M108 134 Q128 138 150 134`);
  // arm to the grip, bars
  p.push(`M196 110 L220 102`);
  p.push(tube([[164, 88], [188, 108], [204, 110]], [8.5, 7.5, 6.5]));
  p.push(circle(206, 110, 7));
  // helmet with visor and chin bar
  p.push(circle(166, 52, 22));
  p.push(`M168 42 Q188 40 190 52 Q190 64 172 64 Q164 60 168 42 Z`);
  p.push(`M146 60 Q160 72 180 72`);
  D.motorcycle = p;
}

// Shift every path so the viewBox starts at 0 0; arcs keep radii and flags, only endpoints move.
function shift(d, ox, oy) {
  return d.replace(/([MLQCA])([^MLQCAZ]*)/g, (_, c, body) => {
    const n = body.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const o = n.map((v, i) => {
      if (c === 'A') { const k = i % 7; return k === 5 ? r1(v - ox) : k === 6 ? r1(v - oy) : v; }
      return i % 2 ? r1(v - oy) : r1(v - ox);
    });
    return `${c}${o.join(' ')} `;
  }).replace(/ Z/g, ' Z').replace(/\s+/g, ' ').trim();
}
const VB = { hike: [3, 27, 296, 246], bike: [10, 29, 280, 247], motorcycle: [9, 25, 281, 249] };
let ts = '';
for (const k of ['hike', 'bike', 'motorcycle']) {
  const [x, y, w, h] = VB[k];
  const paths = D[k].map((d) => shift(d, x, y));
  ts += `  ${k}: {\n    viewBox: '0 0 ${w} ${h}',\n    width: ${w},\n    height: ${h},\n    paths: [\n${paths.map((d) => `      '${d}',`).join('\n')}\n    ],\n  },\n`;
  const W = 540;
  writeFileSync(join(OUT, `${k}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(W * h / w)}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${paths.map((d) => `<path d="${d}" fill="${d.endsWith('Z') ? '#fff' : 'none'}" stroke="#181817" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>`);
}
writeFileSync(join(OUT, 'drawings.ts.txt'), ts);
