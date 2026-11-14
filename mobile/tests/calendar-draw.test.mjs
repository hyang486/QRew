// Run: npm test. Qrewing Calendar drawing: stacked lanes, "+N" overflow, month-boundary strokes, dark-mode colors.
import './ts-resolve.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const plan = await import('../src/features/calendar/calendar-plan.ts');
const { weekSegments, monthInfo, primarySegments, PRESSURE_OPACITY } = await import('../src/components/calendar/sketch.ts');
const { MAX_LANES, layoutMonth, overflowByDay, monthGrid, cellOf, keyOf, itemsOnDay } = plan;

const item = (id, start, end) => ({ id, kind: 'room', title: id, start, end, emoji: '*' });
const pad = (n) => String(n).padStart(2, '0');
const key = (y, m0, d) => keyOf(y, m0, d);

// Day-offset helpers on UTC midnights (no DST drift).
const toMs = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const fromMs = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const add = (k, n) => fromMs(toMs(k) + n * 86400000);

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Months that stress the grid: 6-row months, year wrap, leap February, a month starting on the last column.
const MONTHS = [
  [2026, 10], // Nov 2026: Sunday start, 5 rows
  [2026, 7], // Aug 2026: Saturday start, 6 rows
  [2026, 11], // Dec 2026 -> Jan 2027 wrap
  [2027, 0], // Jan 2027: 6 rows
  [2028, 1], // Feb 2028: leap, 29 days
  [2026, 1], // Feb 2026: 28 days, Sunday start, exactly 4 rows
];

function randomItems(y, m0, n, r) {
  const first = key(y, m0, 1);
  return Array.from({ length: n }, (_, i) => {
    const start = add(first, Math.floor(r() * 50) - 10); // may begin last month
    return item(`i${i}`, start, add(start, Math.floor(r() * 20))); // may run into next month
  });
}

test('grid shapes: 6-row, leap and 4-row months', () => {
  assert.equal(monthGrid(2026, 7).rows, 6);
  assert.equal(monthGrid(2027, 0).rows, 6);
  assert.equal(monthGrid(2028, 1).days, 29);
  assert.equal(monthGrid(2026, 1).rows, 4);
  for (const [y, m0] of MONTHS) {
    const g = monthGrid(y, m0);
    const info = monthInfo(y, m0);
    assert.deepEqual([info.firstCol, info.daysInMonth, info.weeks], [g.offset, g.days, g.rows], `${y}-${m0 + 1}`);
  }
});

test('month boundary: each item covers exactly its days inside the month, one row run per week, caps only at real ends', () => {
  for (const [y, m0] of MONTHS) {
    const g = monthGrid(y, m0);
    const first = key(y, m0, 1);
    const last = key(y, m0, g.days);
    const items = randomItems(y, m0, 40, rng(y * 12 + m0));
    const segs = layoutMonth(items, g);
    for (const it of items) {
      const mine = segs.filter((s) => s.itemId === it.id);
      const inMonth = it.start <= last && it.end >= first;
      if (!inMonth) {
        assert.equal(mine.length, 0, `${it.id} outside ${y}-${m0 + 1}`);
        continue;
      }
      // Expected cells, day by day.
      const want = new Set();
      for (let k = it.start < first ? first : it.start; k <= it.end && k <= last; k = add(k, 1)) {
        const { row, col } = cellOf(g, +k.slice(8, 10));
        want.add(`${row}:${col}`);
      }
      const got = new Set();
      const drawnRows = new Set();
      for (const s of mine) {
        assert.ok(s.colStart <= s.colEnd && s.colStart >= 0 && s.colEnd <= 6);
        // A row may be split at full days (hidden there), but each cell is covered once and drawn at most once per row.
        if (s.lane < MAX_LANES) {
          assert.ok(!drawnRows.has(s.row), `${it.id}: one drawn segment per row`);
          drawnRows.add(s.row);
        }
        for (let c = s.colStart; c <= s.colEnd; c++) {
          assert.ok(!got.has(`${s.row}:${c}`), `${it.id}: cell covered once`);
          got.add(`${s.row}:${c}`);
        }
      }
      assert.deepEqual([...got].sort(), [...want].sort(), `${it.id} cells in ${y}-${m0 + 1}`);
      const sorted = [...mine].sort((a, b) => a.row - b.row || a.colStart - b.colStart);
      assert.equal(sorted[0].capStart, it.start >= first, `${it.id} start cap`);
      assert.equal(sorted.at(-1).capEnd, it.end <= last, `${it.id} end cap`);
      for (const s of sorted.slice(1)) assert.equal(s.capStart, false, 'week wrap or split has no start cap');
      for (const s of sorted.slice(0, -1)) assert.equal(s.capEnd, false, 'week wrap or split has no end cap');
      assert.equal(mine.filter((s) => s.emoji).length, 1, `${it.id}: exactly one emoji`);
    }
  }
});

test('month boundary: a room from Oct 30 to Nov 2 is cut on the October side only, in both months', () => {
  const it = item('r', '2026-10-30', '2026-11-02');
  const [nov] = layoutMonth([it], monthGrid(2026, 10));
  assert.deepEqual([nov.row, nov.colStart, nov.colEnd, nov.capStart, nov.capEnd], [0, 0, 1, false, true]);
  const oct = layoutMonth([it], monthGrid(2026, 9));
  assert.equal(oct.length, 1);
  assert.deepEqual([oct[0].colStart, oct[0].colEnd, oct[0].capStart, oct[0].capEnd], [5, 6, true, false]);
  // Year wrap: Dec 30 -> Jan 2 is cut on the December end and the January start.
  const ny = item('y', '2026-12-30', '2027-01-02');
  const dec = layoutMonth([ny], monthGrid(2026, 11));
  const jan = layoutMonth([ny], monthGrid(2027, 0));
  assert.deepEqual([dec.at(-1).capStart, dec.at(-1).capEnd], [true, false]);
  assert.deepEqual([jan[0].capStart, jan[0].capEnd, jan[0].colStart], [false, true, 5]);
});

test('weekSegments (component helper) agrees with the screen layout on rows, columns and caps', () => {
  for (const [y, m0] of MONTHS) {
    const g = monthGrid(y, m0);
    const info = monthInfo(y, m0);
    const first = key(y, m0, 1);
    for (const it of randomItems(y, m0, 30, rng(7 + y + m0))) {
      const startDay = Math.round((toMs(it.start) - toMs(first)) / 86400000) + 1;
      const endDay = Math.round((toMs(it.end) - toMs(first)) / 86400000) + 1;
      const a = weekSegments(info, startDay, endDay).map((s) => [s.row, s.colStart, s.colEnd, s.startCap === 'round', s.endCap === 'round']);
      const b = layoutMonth([it], g).map((s) => [s.row, s.colStart, s.colEnd, s.capStart, s.capEnd]);
      assert.deepEqual(a, b, `${it.start}..${it.end} in ${y}-${m0 + 1}`);
    }
  }
});

test('lanes: no two strokes in a row share a lane where they overlap; each stroke takes the lowest free lane', () => {
  for (const [y, m0] of MONTHS) {
    const segs = layoutMonth(randomItems(y, m0, 60, rng(99 + m0)), monthGrid(y, m0));
    for (const s of segs) {
      const overlaps = (o) => o !== s && o.row === s.row && !(o.colEnd < s.colStart || o.colStart > s.colEnd);
      const before = segs.slice(0, segs.indexOf(s));
      assert.ok(!segs.some((o) => overlaps(o) && o.lane === s.lane), 'lane collision');
      for (let l = 0; l < s.lane; l++) assert.ok(before.some((o) => overlaps(o) && o.lane === l), `lane ${l} was free`);
    }
  }
});

test('lanes: touching ranges share a lane, overlapping ones stack', () => {
  const g = monthGrid(2026, 10);
  const [a, b] = layoutMonth([item('a', '2026-11-02', '2026-11-03'), item('b', '2026-11-04', '2026-11-05')], g);
  assert.deepEqual([a.lane, b.lane], [0, 0]);
  const [c, d] = layoutMonth([item('c', '2026-11-02', '2026-11-04'), item('d', '2026-11-04', '2026-11-05')], g);
  assert.deepEqual([c.lane, d.lane], [0, 1]);
});

test('+N: four or five rooms on one day show 3 strokes and +1 or +2 on that day only', () => {
  const g = monthGrid(2026, 10);
  const four = ['a', 'b', 'c', 'd'].map((id) => item(id, '2026-11-13', '2026-11-13'));
  const s4 = layoutMonth(four, g);
  assert.deepEqual(s4.map((s) => s.lane), [0, 1, 2, 3]);
  assert.deepEqual([...overflowByDay(s4, g)], [[13, 1]]);
  const s5 = layoutMonth([...four, item('e', '2026-11-13', '2026-11-13')], g);
  assert.deepEqual([...overflowByDay(s5, g)], [[13, 2]]);
  assert.equal(s5.filter((s) => s.lane < MAX_LANES).length, MAX_LANES);
});

test('+N: drawn strokes plus the +N count equal the rooms on every day', () => {
  for (const [y, m0] of MONTHS) {
    const g = monthGrid(y, m0);
    const items = randomItems(y, m0, 50, rng(31 * m0 + y));
    const segs = layoutMonth(items, g);
    const over = overflowByDay(segs, g);
    for (let day = 1; day <= g.days; day++) {
      const { row, col } = cellOf(g, day);
      const drawn = segs.filter((s) => s.row === row && s.lane < MAX_LANES && s.colStart <= col && s.colEnd >= col).length;
      const total = itemsOnDay(items, key(y, m0, day)).length;
      assert.equal(drawn + (over.get(day) ?? 0), total, `${y}-${m0 + 1}-${day}`);
      assert.ok(drawn <= MAX_LANES);
    }
  }
});

test('VoiceOver: a room whose first row is hidden (+N) is still one element on its next drawn row', () => {
  const g = monthGrid(2026, 10);
  // Three rooms fill Nov 13-14 (row 1); room x starts later (Nov 14-17), so its row-1 segment is lane 3 (hidden).
  const items = [
    item('a', '2026-11-13', '2026-11-14'),
    item('b', '2026-11-13', '2026-11-14'),
    item('c', '2026-11-13', '2026-11-14'),
    item('x', '2026-11-14', '2026-11-17'),
  ];
  const all = layoutMonth(items, g);
  assert.equal(all.find((s) => s.itemId === 'x' && s.row === 1).lane, 3);
  const shown = all.filter((s) => s.lane < MAX_LANES);
  const keys = primarySegments(shown);
  assert.ok(keys.has('x:2'), 'x is announced on row 2');
  assert.equal([...keys].filter((k) => k.startsWith('x:')).length, 1);
  assert.equal(keys.size, 4);
});

// ---- Colors (parsed from the token source: tokens.ts imports react-native, which node cannot load).

const hexes = (block) => [...block.matchAll(/'#([0-9A-Fa-f]{6})'/g)].map((m) => m[1]);
const tokens = readFileSync(new URL('../src/components/calendar/tokens.ts', import.meta.url), 'utf8');
function theme(name) {
  const block = tokens.slice(tokens.indexOf(`${name}: {`), tokens.indexOf('},', tokens.indexOf(`${name}: {`)));
  const paper = /paper: '#([0-9A-Fa-f]{6})'/.exec(block)[1];
  const hl = hexes(/highlighters: \[([^\]]*)\]/.exec(block)[1]);
  const opacity = +/highlighterOpacity: ([\d.]+)/.exec(block)[1];
  const ink = /ink: '#([0-9A-Fa-f]{6})'/.exec(block)[1];
  const pencil = /pencil: '#([0-9A-Fa-f]{6})'/.exec(block)[1];
  return { paper, hl, opacity, ink, pencil };
}
const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (c) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const over = (fg, alpha, bg) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

test('dark mode: same number of highlighters, so a room keeps its hue slot when the theme flips', () => {
  const L = theme('light');
  const D = theme('dark');
  assert.equal(L.hl.length, D.hl.length);
  assert.ok(L.hl.length >= 6);
  assert.equal(new Set(D.hl.map((h) => h.toLowerCase())).size, D.hl.length, 'dark highlighters are distinct');
});

test('dark mode: day numbers and grid lines stay readable on the paper in both themes', () => {
  for (const name of ['light', 'dark']) {
    const t = theme(name);
    const paper = rgb(t.paper);
    assert.ok(contrast(rgb(t.ink), paper) >= 4.5, `${name}: day number contrast`);
    // Grid lines are pencil at the lightest pressure (sketch.ts PRESSURE_OPACITY[0]): a non-text graphic needs 3:1.
    assert.ok(contrast(over(rgb(t.pencil), PRESSURE_OPACITY[0], paper), paper) >= 3, `${name}: grid line contrast`);
  }
});

test('dark mode: a highlighter on the dark paper is dimmer than on the light paper but still visible', () => {
  const L = theme('light');
  const D = theme('dark');
  L.hl.forEach((h, i) => {
    const onLight = over(rgb(h), L.opacity, rgb(L.paper));
    const onDark = over(rgb(D.hl[i]), D.opacity, rgb(D.paper));
    assert.ok(lum(onDark) < lum(onLight), `slot ${i}: dark band is dimmer`);
    assert.ok(contrast(onDark, rgb(D.paper)) >= 1.5, `slot ${i}: dark band stands off the paper`);
    // Ink (the day list, emoji edges) over the band stays readable.
    assert.ok(contrast(rgb(D.ink), onDark) >= 3, `slot ${i}: ink over dark band`);
  });
});
