// Run: npm test. Qrewing Calendar date math: month grid, clipping, week wrapping, lanes, time zones, DST.
import './ts-resolve.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const p = await import('../src/features/calendar/calendar-plan.ts');
const item = (id, start, end, kind = 'room') => ({ id, kind, title: id, start, end, emoji: '🏃' });

test('monthGrid: November 2026 starts on Sunday, 5 rows; Monday start shifts it', () => {
  assert.deepEqual(p.monthGrid(2026, 10), { year: 2026, month0: 10, rows: 5, offset: 0, days: 30 });
  assert.equal(p.monthGrid(2026, 10, 1).offset, 6);
  assert.equal(p.monthGrid(2026, 10, 1).rows, 6);
  assert.equal(p.monthGrid(2027, 1).days, 28);
  assert.equal(p.monthGrid(2028, 1).days, 29);
});

test('shiftMonth carries the year both ways', () => {
  assert.deepEqual(p.shiftMonth(2026, 11, 1), { year: 2027, month0: 0 });
  assert.deepEqual(p.shiftMonth(2026, 0, -1), { year: 2025, month0: 11 });
});

test('a range inside one week is one segment with both caps and the emoji', () => {
  const g = p.monthGrid(2026, 10);
  const segs = p.layoutMonth([item('a', '2026-11-15', '2026-11-17')], g);
  assert.deepEqual(segs, [{ itemId: 'a', row: 2, colStart: 0, colEnd: 2, capStart: true, capEnd: true, lane: 0, emoji: true }]);
});

test('a range across a week boundary wraps into two rows with cut caps; the emoji sits on the middle date', () => {
  const g = p.monthGrid(2026, 10);
  const segs = p.layoutMonth([item('a', '2026-11-13', '2026-11-17')], g);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => [s.row, s.colStart, s.colEnd, s.capStart, s.capEnd, s.emoji]), [
    [1, 5, 6, true, false, false],
    [2, 0, 2, false, true, true],
  ]);
});

test('ranges are clipped to the shown month; the clipped side has no cap', () => {
  const g = p.monthGrid(2026, 10);
  const segs = p.layoutMonth([item('a', '2026-10-30', '2026-11-02'), item('b', '2026-11-29', '2026-12-03')], g);
  const a = segs.filter((s) => s.itemId === 'a');
  assert.deepEqual(a.map((s) => [s.row, s.colStart, s.colEnd, s.capStart, s.capEnd]), [[0, 0, 1, false, true]]);
  const b = segs.filter((s) => s.itemId === 'b');
  assert.deepEqual(b.map((s) => [s.row, s.colStart, s.colEnd, s.capStart, s.capEnd]), [[4, 0, 1, true, false]]);
  assert.equal(p.layoutMonth([item('c', '2026-12-01', '2026-12-02')], g).length, 0);
});

test('a range longer than the month covers every row', () => {
  const g = p.monthGrid(2026, 10);
  const segs = p.layoutMonth([item('a', '2026-10-01', '2027-01-01')], g);
  assert.equal(segs.length, g.rows);
  assert.ok(segs.every((s) => !s.capStart || s.row > 0));
  assert.equal(segs.filter((s) => s.emoji).length, 1);
});

test('overlapping items in a row take separate lanes; a free lane is reused; overflow counts days', () => {
  const g = p.monthGrid(2026, 10);
  const items = [item('a', '2026-11-15', '2026-11-16'), item('b', '2026-11-16', '2026-11-18'), item('c', '2026-11-19', '2026-11-20')];
  const lanes = Object.fromEntries(p.layoutMonth(items, g).map((s) => [s.itemId, s.lane]));
  assert.deepEqual(lanes, { a: 0, b: 1, c: 0 });
  const many = ['a', 'b', 'c', 'd'].map((id) => item(id, '2026-11-10', '2026-11-10'));
  const segs = p.layoutMonth(many, g);
  assert.equal(Math.max(...segs.map((s) => s.lane)), 3);
  assert.equal(p.overflowByDay(segs, g).get(10), 1);
});

test('localDateKey follows the time zone', () => {
  const t = '2026-11-15T07:30:00Z';
  assert.equal(p.localDateKey(t, 'America/Los_Angeles'), '2026-11-14');
  assert.equal(p.localDateKey(t, 'Asia/Seoul'), '2026-11-15');
});

test('DST: day math across the US fall-back and spring-forward days stays whole', () => {
  assert.equal(p.addDays('2026-10-31', 2), '2026-11-02');
  assert.equal(p.daysBetween('2026-11-01', '2026-11-02'), 1);
  assert.equal(p.addDays('2026-03-07', 2), '2026-03-09');
  // 23:30 local on the fall-back day is still Nov 1 in Los Angeles.
  assert.equal(p.localDateKey('2026-11-02T07:30:00Z', 'America/Los_Angeles'), '2026-11-01');
});

test('roomRange: starts_at wins over created_at; midnight end is the day before; early end wins', () => {
  const tz = 'America/Los_Angeles';
  const room = { starts_at: '2026-11-15T16:00:00Z', created_at: '2026-11-10T16:00:00Z', expires_at: '2026-11-18T08:00:00Z', deleted_at: null };
  assert.deepEqual(p.roomRange(room, tz), { start: '2026-11-15', end: '2026-11-17' });
  assert.deepEqual(p.roomRange({ ...room, starts_at: null }, tz), { start: '2026-11-10', end: '2026-11-17' });
  assert.deepEqual(p.roomRange({ ...room, deleted_at: '2026-11-16T03:00:00Z' }, tz), { start: '2026-11-15', end: '2026-11-15' });
  assert.deepEqual(p.roomRange({ ...room, starts_at: '2026-11-20T16:00:00Z' }, tz), { start: '2026-11-20', end: '2026-11-20' });
});

test('itemsOnDay and isDateKey', () => {
  const items = [item('a', '2026-11-15', '2026-11-17'), item('b', '2026-11-17', '2026-11-17')];
  assert.deepEqual(p.itemsOnDay(items, '2026-11-17').map((i) => i.id), ['a', 'b']);
  assert.equal(p.isDateKey('2026-02-30'), false);
  assert.equal(p.isDateKey('2026-02-28'), true);
});

test('itemAction: rooms open the diary on Plus and the upsell on Free; events always edit; unread Plus waits', () => {
  assert.equal(p.itemAction('room', true), 'diary');
  assert.equal(p.itemAction('room', false), 'upsell');
  assert.equal(p.itemAction('room', null), null);
  assert.equal(p.itemAction('event', true), 'edit');
  assert.equal(p.itemAction('event', false), 'edit');
  assert.equal(p.itemAction('event', null), 'edit');
});

test('barAction: VoiceOver says open diary on Plus, Plus feature on Free, edit event for my events', () => {
  assert.equal(p.barAction('room', true), 'diary');
  assert.equal(p.barAction('room', false), 'plus');
  assert.equal(p.barAction('room', null), 'plus');
  assert.equal(p.barAction('event', false), 'edit');
});

test('isPastRoom uses the end instant, not the end-day key read as UTC (qa 2026-11-13, Plus current room)', () => {
  // LA evening Nov 13 = 2026-11-14T04:00Z; the room expires Nov 14 10:00 LA. Its end key "2026-11-14" is
  // UTC midnight, already before now, yet the room is still open.
  const now = Date.parse('2026-11-14T04:00:00Z');
  const open = { end: '2026-11-14', endAt: '2026-11-14T18:00:00Z' };
  assert.equal(Date.parse(open.end) <= now, true, 'the old rule called it past');
  assert.equal(p.isPastRoom(open, now), false);
  assert.equal(p.isPastRoom({ end: '2026-11-13', endAt: '2026-11-14T03:59:59Z' }, now), true);
  assert.equal(p.isPastRoom({ end: '2026-11-13', endAt: '2026-11-14T04:00:00Z' }, now), true, 'ending now is past');
});

test('isPastRoom: an unreadable endAt falls back to the local midnight after the end day', () => {
  const [y, m, d] = [2026, 11, 14];
  const after = new Date(y, m - 1, d + 1).getTime();
  for (const endAt of ['', 'soon', undefined]) {
    assert.equal(p.isPastRoom({ end: '2026-11-14', endAt }, after - 1), false);
    assert.equal(p.isPastRoom({ end: '2026-11-14', endAt }, after), true);
  }
});
