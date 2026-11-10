// Run: npm test. Qrew unit 5 (Q 06.04): the ended screen's closed-at time is shown only when it is known.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { endTimerDelay, MAX_TIMER_MS, roomClosedAtMs, roomOverState, sameLocalDay } from '../src/lib/room-ended.ts';

const NOW = Date.UTC(2026, 10, 9, 20);
const iso = (ms) => new Date(ms).toISOString();

test('roomClosedAtMs: no room row means no time', () => {
  assert.equal(roomClosedAtMs(null, NOW), null);
  assert.equal(roomClosedAtMs(undefined, NOW), null);
});

test('roomClosedAtMs: the host end time wins over the planned end', () => {
  const ended = NOW - 600_000;
  assert.equal(roomClosedAtMs({ deleted_at: iso(ended), expires_at: iso(NOW + 3_600_000) }, NOW), ended);
});

test('roomClosedAtMs: a passed end time is the closed time; a future one is not', () => {
  assert.equal(roomClosedAtMs({ deleted_at: null, expires_at: iso(NOW - 1000) }, NOW), NOW - 1000);
  assert.equal(roomClosedAtMs({ deleted_at: null, expires_at: iso(NOW) }, NOW), NOW);
  assert.equal(roomClosedAtMs({ deleted_at: null, expires_at: iso(NOW + 1000) }, NOW), null);
});

test('roomClosedAtMs: unreadable times give no time', () => {
  assert.equal(roomClosedAtMs({ deleted_at: 'x', expires_at: iso(NOW - 1000) }, NOW), null);
  assert.equal(roomClosedAtMs({ deleted_at: null, expires_at: 'x' }, NOW), null);
});

test('sameLocalDay', () => {
  const noon = new Date(2026, 10, 9, 12).getTime();
  assert.equal(sameLocalDay(noon, new Date(2026, 10, 9, 23, 59).getTime()), true);
  assert.equal(sameLocalDay(noon, new Date(2026, 10, 10, 0, 0).getTime()), false);
});

// G-U6-1: open room screens switch to the ended screen when the room ends.
test('endTimerDelay: time left until the end, 0 once passed, capped, null when unreadable', () => {
  assert.equal(endTimerDelay(iso(NOW + 90_000), NOW), 90_000);
  assert.equal(endTimerDelay(iso(NOW), NOW), 0);
  assert.equal(endTimerDelay(iso(NOW - 5_000), NOW), 0);
  assert.equal(endTimerDelay(iso(NOW + 40 * 86_400_000), NOW), MAX_TIMER_MS);
  assert.equal(endTimerDelay('not a time', NOW), null);
});

test('roomOverState: nothing loaded is not over', () => {
  assert.deepEqual(roomOverState(null, null), { over: false });
  assert.deepEqual(roomOverState(undefined, { expiresAt: iso(NOW), atMs: NOW }), { over: false });
});

test('roomOverState: a host end is over at once, with no seen time needed', () => {
  assert.deepEqual(roomOverState({ deleted_at: iso(NOW - 1000), expires_at: iso(NOW + 3_600_000) }, null), {
    over: true,
  });
});

test('roomOverState: over once the timer saw this end time pass', () => {
  const room = { deleted_at: null, expires_at: iso(NOW) };
  assert.deepEqual(roomOverState(room, null), { over: false });
  assert.deepEqual(roomOverState(room, { expiresAt: iso(NOW), atMs: NOW + 20 }), { over: true, nowMs: NOW + 20 });
});

test('roomOverState: an end seen for an older end time does not count after the host extends the room', () => {
  const extended = { deleted_at: null, expires_at: iso(NOW + 3_600_000) };
  assert.deepEqual(roomOverState(extended, { expiresAt: iso(NOW), atMs: NOW }), { over: false });
});
