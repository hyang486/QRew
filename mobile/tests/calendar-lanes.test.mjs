// Run: npm test. Calendar findings from the draw tests (8d8f503). F1: a room that hit full lanes on one day was
// hidden ("+1") for the whole week row although lanes were free on its other days. F2: "+N" sat on the lane-2 stroke.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const plan = await import('../src/features/calendar/calendar-plan.ts');
const { MAX_LANES, layoutMonth, overflowByDay, monthGrid } = plan;
const { primarySegments } = await import('../src/components/calendar/sketch.ts');

const item = (id, start, end) => ({ id, kind: 'room', title: id, start, end, emoji: '*' });
const g = monthGrid(2026, 10); // Nov 2026: Nov 8-14 is row 1, cols 0-6

const F1 = [
  item('a', '2026-11-08', '2026-11-09'),
  item('b', '2026-11-08', '2026-11-09'),
  item('c', '2026-11-08', '2026-11-09'),
  item('d', '2026-11-09', '2026-11-14'),
];

test('F1: a room is hidden only on its full days, drawn on the free days of the same row', () => {
  const segs = layoutMonth(F1, g);
  assert.deepEqual([...overflowByDay(segs, g)], [[9, 1]]);
  const d = segs.filter((s) => s.itemId === 'd');
  const shownCols = d.filter((s) => s.lane < MAX_LANES).flatMap((s) => range(s.colStart, s.colEnd));
  assert.deepEqual(shownCols, [2, 3, 4, 5, 6]);
  // The cut ends are flat, the real end stays round; one emoji for d.
  const vis = d.find((s) => s.lane < MAX_LANES);
  assert.equal(vis.capStart, false);
  assert.equal(vis.capEnd, true);
  assert.equal(d.filter((s) => s.emoji).length, 1);
});

test('F1: a room that fits one lane for its whole row is not split', () => {
  const segs = layoutMonth([item('a', '2026-11-08', '2026-11-09'), item('d', '2026-11-09', '2026-11-14')], g);
  assert.equal(segs.filter((s) => s.itemId === 'd').length, 1);
});

test('F1: at most one drawn piece per room per row, so VoiceOver keys and React keys stay one per room row', () => {
  const shown = layoutMonth(F1, g).filter((s) => s.lane < MAX_LANES);
  const keys = primarySegments(shown);
  assert.equal([...keys].filter((k) => k.startsWith('d:')).length, 1);
  assert.equal(keys.size, 4);
  let seed = 7;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let n = 0; n < 300; n++) {
    const items = Array.from({ length: 4 + Math.floor(r() * 10) }, (_, i) => {
      const s = 1 + Math.floor(r() * 30);
      return item(`r${i}`, `2026-11-${String(s).padStart(2, '0')}`, `2026-11-${String(Math.min(30, s + Math.floor(r() * 9))).padStart(2, '0')}`);
    });
    const segs = layoutMonth(items, g);
    const shownKeys = segs.filter((s) => s.lane < MAX_LANES).map((s) => `${s.itemId}:${s.row}`);
    assert.equal(new Set(shownKeys).size, shownKeys.length);
    for (const it of items) assert.equal(segs.filter((s) => s.itemId === it.id && s.emoji).length, 1);
    // Drawn strokes + "+N" = rooms on each day, and no visible lane is shared on a day.
    const over = overflowByDay(segs, g);
    for (let day = 1; day <= 30; day++) {
      const k = `2026-11-${String(day).padStart(2, '0')}`;
      const on = items.filter((x) => x.start <= k && x.end >= k).length;
      const { row, col } = { row: Math.floor((day - 1 + g.offset) / 7), col: (day - 1 + g.offset) % 7 };
      const here = segs.filter((s) => s.row === row && s.colStart <= col && s.colEnd >= col);
      const vis = here.filter((s) => s.lane < MAX_LANES);
      assert.equal(new Set(here.map((s) => s.lane)).size, here.length);
      assert.equal(vis.length + (over.get(day) ?? 0), on);
      // A room is hidden on a day only when every visible lane is taken there.
      if (over.get(day)) assert.equal(vis.length, MAX_LANES);
    }
  }
});

test('F2: "+N" sits in the day-number band, above every lane', () => {
  const src = readFileSync(new URL('../src/features/calendar/calendar-screen.tsx', import.meta.url), 'utf8');
  const num = (name) => Number(src.match(new RegExp(`const ${name} = (\\d+);`))[1]);
  const more = src.match(/\n {2}more: \{([^}]*)\}/)[1];
  assert.doesNotMatch(more, /bottom:/);
  const top = Number(more.match(/top: (\d+)/)[1]);
  // Tiers FINAL: "+N" is a button (styles.more) around its text (styles.moreText).
  const size = Number(src.match(/\n {2}moreText: \{([^}]*)\}/)[1].match(/fontSize: (\d+)/)[1]);
  // Text box ≈ 1.3 × font size; it must end before lane 0 starts (DAY_H).
  assert.ok(top + Math.ceil(size * 1.3) <= num('DAY_H'), `+N ends at ${top + size * 1.3}`);
});

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
