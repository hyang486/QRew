// Run: npm test (node --test, Node 24 strips the .ts types).
// Qrewing Calendar drawing geometry: seeded wobble, highlighter caps, month layout, week segments.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  gridPencil,
  markerBar,
  monthInfo,
  PENCIL_DRIFT,
  pencilStrokes,
  seededRandom,
  weekSegments,
} from '../src/components/calendar/sketch.ts';

test('the same seed draws the same lines; another seed draws different ones', () => {
  assert.deepEqual(gridPencil(5, 48, 64, 'nov'), gridPencil(5, 48, 64, 'nov'));
  assert.notDeepEqual(gridPencil(5, 48, 64, 'nov'), gridPencil(5, 48, 64, 'dec'));
  assert.deepEqual(markerBar(120, 14, 'round', 'flat', 'a'), markerBar(120, 14, 'round', 'flat', 'a'));
  const r = seededRandom('x');
  for (let i = 0; i < 100; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1);
  }
});

// Subpaths "Mx y Lx y" of a pencil pass, as [x1, y1, x2, y2].
const pieces = (d) => [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)/g)].map((m) => m.slice(1).map(Number));
const allPieces = (passes) => passes.flatMap((p) => pieces(p.d));

test('grid pencil: a dozen-ish bucketed paths, not one path per piece', () => {
  const passes = gridPencil(6, 48, 64, 's');
  assert.ok(passes.length >= 4 && passes.length <= 13, `${passes.length} paths`);
  for (const p of passes) assert.ok(p.opacity > 0 && p.opacity <= 1 && p.width > 0 && p.width <= 1.7);
});

test('grid pencil: lines are straight and even (≤ 1 px off their line) and cover every grid line end to end', () => {
  const [w, h, cw, ch, weeks] = [336, 384, 48, 64, 6];
  const all = allPieces(gridPencil(weeks, cw, ch, 's'));
  const near = (v, grid) => Math.abs(v - Math.round(v / grid) * grid);
  const isH = ([x1, y1, x2, y2]) => Math.abs(x2 - x1) >= Math.abs(y2 - y1);
  const horiz = all.filter(isH);
  const vert = all.filter((p) => !isH(p));
  for (const [, y1, , y2] of horiz) assert.ok(near(y1, ch) <= 1.05 && near(y2, ch) <= 1.05, `horizontal piece at y ${y1}`);
  for (const [x1, , x2] of vert) assert.ok(near(x1, cw) <= 1.05 && near(x2, cw) <= 1.05, `vertical piece at x ${x1}`);
  for (let r = 0; r <= weeks; r++) {
    const row = horiz.filter(([, y]) => Math.round(y / ch) === r).flatMap(([x1, , x2]) => [x1, x2]);
    assert.ok(Math.min(...row) <= 0.2 && Math.max(...row) >= w - 0.2, `row ${r} spans the grid`);
  }
  for (let c = 0; c <= 7; c++) {
    const col = vert.filter(([x]) => Math.round(x / cw) === c).flatMap(([, y1, , y2]) => [y1, y2]);
    assert.ok(Math.min(...col) <= 0.2 && Math.max(...col) >= h - 0.2, `column ${c} spans the grid`);
  }
});

test('pencil: the core stroke drifts at most PENCIL_DRIFT and has pressure variation and grain', () => {
  const passes = pencilStrokes([[0, 10, 300, 10]], 'w');
  const core = passes.filter((p) => p.width >= 1);
  for (const [, y1, , y2] of core.flatMap((p) => pieces(p.d))) {
    assert.ok(Math.abs(y1 - 10) <= PENCIL_DRIFT + 0.05 && Math.abs(y2 - 10) <= PENCIL_DRIFT + 0.05);
  }
  assert.ok(new Set(core.map((p) => p.opacity)).size >= 2, 'pressure varies');
  assert.ok(passes.some((p) => p.width < 1), 'has a grain pass');
  const ends = core.flatMap((p) => pieces(p.d)).flatMap(([x1, y1, x2, y2]) => [[x1, y1], [x2, y2]]);
  assert.ok(ends.some(([x, y]) => x === 0 && y === 10), 'starts exactly on its endpoint');
  assert.ok(ends.some(([x, y]) => x === 300 && y === 10), 'ends exactly on its endpoint');
  assert.deepEqual(pencilStrokes([[5, 5, 5, 5]], 'z'), [], 'zero-length line draws nothing');
});

test('marker bar: straight bar (no arcs, not a pill), exact cut on flat caps, chisel inside the box on real ends', () => {
  const flat = markerBar(100, 14, 'flat', 'flat', 's');
  assert.equal(flat.body, 'M0 0 L100 0 L100 14 L0 14 Z');
  for (const caps of [['round', 'round'], ['round', 'flat'], ['flat', 'round']]) {
    const bar = markerBar(100, 14, caps[0], caps[1], 's');
    assert.doesNotMatch(bar.body, /A/);
    const xs = bar.body.match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 0);
    for (const x of xs) assert.ok(x >= 0 && x <= 100);
    if (caps[0] === 'flat') assert.match(bar.body, /^M0 0 /);
    if (caps[1] === 'flat') assert.match(bar.body, / L100 0 L100 14 /);
  }
  assert.equal(markerBar(0, 14, 'round', 'round', 's'), null);
});

test('marker bar: grain streaks run along the bar, stay inside it, and come in up to 3 opacities', () => {
  const bar = markerBar(120, 14, 'round', 'flat', 'g');
  assert.ok(bar.streaks.length >= 1 && bar.streaks.length <= 3);
  for (const s of bar.streaks) {
    assert.ok(s.opacity > 0 && s.opacity < 0.5);
    for (const [x1, y1, x2, y2] of pieces(s.d)) {
      assert.equal(y1, y2, 'horizontal');
      assert.ok(y1 > 0 && y1 < 14 && x1 >= 0 && x2 <= 120 && x2 >= x1);
    }
  }
  // Narrower than its tip: still a valid bar.
  assert.ok(markerBar(3, 14, 'round', 'round', 's').body.startsWith('M'));
});

test('monthInfo: November 2026 starts on a Sunday, 30 days, 5 rows', () => {
  assert.deepEqual(monthInfo(2026, 10), { firstCol: 0, daysInMonth: 30, weeks: 5 });
  assert.deepEqual(monthInfo(2026, 10, 1), { firstCol: 6, daysInMonth: 30, weeks: 6 });
  assert.equal(monthInfo(2027, 1).daysInMonth, 28);
});

test('weekSegments: one row, two rows, clamped ends, emoji on the middle day', () => {
  const nov = monthInfo(2026, 10); // Sun Nov 1
  assert.deepEqual(weekSegments(nov, 15, 17), [
    { row: 2, colStart: 0, colEnd: 2, startCap: 'round', endCap: 'round', emoji: true },
  ]);
  // Fri 20 - Mon 23: cut at the week wrap; the middle day (21) is in the first row.
  assert.deepEqual(weekSegments(nov, 20, 23), [
    { row: 2, colStart: 5, colEnd: 6, startCap: 'round', endCap: 'flat', emoji: true },
    { row: 3, colStart: 0, colEnd: 1, startCap: 'flat', endCap: 'round', emoji: false },
  ]);
  // Began last month, runs into next month: flat on both clamped sides.
  const all = weekSegments(nov, -2, 33);
  assert.equal(all.length, 5);
  assert.equal(all[0].startCap, 'flat');
  assert.equal(all[4].endCap, 'flat');
  assert.equal(all.filter((s) => s.emoji).length, 1);
  assert.deepEqual(weekSegments(nov, 31, 40), []);
  assert.deepEqual(weekSegments(nov, 5, 4), []);
  // A single day.
  assert.deepEqual(weekSegments(nov, 30, 30), [
    { row: 4, colStart: 1, colEnd: 1, startCap: 'round', endCap: 'round', emoji: true },
  ]);
});
